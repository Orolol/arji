import fs from "node:fs";
import path from "node:path";
import {
  DOCUMENT_SCAN_EXTENSIONS,
  DOCUMENT_SCAN_IGNORED_DIRECTORIES,
  DOCUMENT_SCAN_MAX_FILES,
} from "./scan-constants";

export interface ScannedDocumentFile {
  /** File name with extension, e.g. "spec-v2.pdf". */
  name: string;
  /** Path relative to the scanned root, POSIX separators, e.g. "docs/spec-v2.pdf". */
  relativePath: string;
  sizeBytes: number;
}

export interface DocumentScanResult {
  /** Absolute root that was scanned (the project's repo path). */
  root: string;
  files: ScannedDocumentFile[];
  /** Per-entry failures (unreadable directory, stat error), already human-readable. */
  errors: string[];
  /** True when the scan stopped at DOCUMENT_SCAN_MAX_FILES. */
  truncated: boolean;
}

/**
 * Walks `root` and collects every document file matching
 * DOCUMENT_SCAN_EXTENSIONS, skipping ignored directories and symlinks.
 *
 * Symlinks are skipped entirely: a symlinked directory could point outside
 * the repo (or loop), and a symlinked "document" would report a size for a
 * file the project does not actually contain. Errors on individual entries
 * are collected into `errors` instead of aborting the walk — one unreadable
 * directory must not hide every other finding.
 */
export function scanProjectDocuments(root: string): DocumentScanResult {
  const files: ScannedDocumentFile[] = [];
  const errors: string[] = [];
  let truncated = false;

  // Iterative walk with an explicit stack: a deep repo must not risk the
  // call-stack limit that a recursive walker would.
  const stack: string[] = [root];

  while (stack.length > 0) {
    if (files.length >= DOCUMENT_SCAN_MAX_FILES) {
      truncated = true;
      break;
    }

    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push(
        `Cannot read directory ${path.relative(root, dir) || "."}: ${
          e instanceof Error ? e.message : "Unknown error"
        }`
      );
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!DOCUMENT_SCAN_IGNORED_DIRECTORIES[entry.name]) {
          stack.push(path.join(dir, entry.name));
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (!DOCUMENT_SCAN_EXTENSIONS[path.extname(entry.name).toLowerCase()])
        continue;
      if (files.length >= DOCUMENT_SCAN_MAX_FILES) {
        truncated = true;
        break;
      }

      const absolutePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(absolutePath);
        files.push({
          name: entry.name,
          relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
          sizeBytes: stat.size,
        });
      } catch (e) {
        errors.push(
          `Cannot stat ${path.relative(root, absolutePath)}: ${
            e instanceof Error ? e.message : "Unknown error"
          }`
        );
      }
    }
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { root, files, errors, truncated };
}
