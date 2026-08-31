/**
 * The `data/documents/` counterpart of `lib/uploads/upload-paths.ts`, and it
 * exists for the same two reasons: `documents.image_path` is a database string
 * that gets unlinked and handed to agents as a path to open, and the join that
 * makes it absolute has to stay statically scoped or Turbopack traces the
 * whole project into the server bundle.
 *
 * See `lib/uploads/upload-paths.ts` for the full note on both rules.
 */

import path from "path";

/** Repo-relative directory every project's uploaded documents live under. */
const DOCUMENTS_RELATIVE_ROOT = "data/documents";

/** Absolute path of `data/documents`. */
export function documentsRoot(): string {
  return path.join(process.cwd(), "data", "documents");
}

/** Absolute path of one project's document directory. */
export function projectDocumentsDirectory(projectId: string): string {
  return path.join(process.cwd(), "data", "documents", projectId);
}

/** Absolute path of one project's document, by on-disk name. */
export function documentFileAbsolutePath(
  projectId: string,
  diskName: string
): string {
  return path.join(process.cwd(), "data", "documents", projectId, diskName);
}

/** Repo-relative path stored in `documents.image_path`. */
export function documentImageRelativePath(
  projectId: string,
  diskName: string
): string {
  return `${DOCUMENTS_RELATIVE_ROOT}/${projectId}/${diskName}`;
}

/**
 * The absolute path a stored `documents.image_path` names, or `null` when it
 * names anything outside `data/documents/`.
 *
 * Prefix *and* resolved path are both checked, for the reason spelled out in
 * `storedUploadAbsolutePath`: a prefix alone accepts a value that climbs back
 * out of the directory it started in.
 */
export function documentImageAbsolutePath(storedPath: unknown): string | null {
  if (typeof storedPath !== "string") return null;

  const trimmed = storedPath.trim();
  const withoutDotSlash = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;

  const prefix = `${DOCUMENTS_RELATIVE_ROOT}/`;
  if (!withoutDotSlash.startsWith(prefix)) return null;

  const withinRoot = withoutDotSlash.slice(prefix.length);
  if (withinRoot.length === 0) return null;

  const documentsDirectory = path.join(process.cwd(), "data", "documents");
  const absolute = path.resolve(documentsDirectory, withinRoot);
  const relativeToRoot = path.relative(documentsDirectory, absolute);

  const inside =
    relativeToRoot.length > 0 &&
    !relativeToRoot.startsWith("..") &&
    !path.isAbsolute(relativeToRoot);

  return inside ? absolute : null;
}
