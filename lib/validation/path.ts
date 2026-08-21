import { stat } from "node:fs/promises";
import { resolve, normalize } from "node:path";

type PathValidationResult =
  | { valid: true; normalizedPath: string }
  | { valid: false; error: string };

export async function validatePath(
  inputPath: string
): Promise<PathValidationResult> {
  if (!inputPath || inputPath.trim().length === 0) {
    return { valid: false, error: "Path is required" };
  }

  if (inputPath.includes("\0")) {
    return { valid: false, error: "Path contains invalid characters" };
  }

  const trimmed = inputPath.trim();

  // Reject `..` as a whole path segment before normalization. A `..` *inside*
  // a file or directory name (e.g. a cloned `repo..v2`, a repo name GitHub
  // allows) is not a traversal: the segments are already isolated by the
  // separator, and the resolve() below normalises the path regardless.
  if (trimmed.split(/[/\\]/).some((segment) => segment === "..")) {
    return {
      valid: false,
      error: "Path must not contain traversal components (..)",
    };
  }

  const normalized = resolve(normalize(trimmed));

  try {
    const stats = await stat(normalized);
    if (!stats.isDirectory()) {
      return { valid: false, error: "Path is not a directory" };
    }
  } catch {
    return {
      valid: false,
      error: "Path does not exist or is not accessible",
    };
  }

  return { valid: true, normalizedPath: normalized };
}
