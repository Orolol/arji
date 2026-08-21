/**
 * Client-safe constants for the project document scanner.
 *
 * Kept free of any `db` or `node:fs` import so the Documents page can import
 * the accepted-extension list for display copy without pulling server modules
 * into the client bundle — same pattern as lib/projects/workspace-constants.ts.
 */

/**
 * File extensions the scanner reports. Mirrors what the upload flow accepts
 * (components/documents/UploadZone.tsx) plus legacy `.doc`, which the epic
 * explicitly names; conversion of legacy `.doc` is an import-side concern.
 */
export const DOCUMENT_SCAN_EXTENSIONS: Record<string, true> = {
  ".pdf": true,
  ".md": true,
  ".txt": true,
  ".doc": true,
  ".docx": true,
};

/**
 * Directory names the scan never descends into: VCS internals, dependency
 * trees, build output and caches. Matched exactly against the entry name.
 */
export const DOCUMENT_SCAN_IGNORED_DIRECTORIES: Record<string, true> = {
  ".git": true,
  ".hg": true,
  ".svn": true,
  "node_modules": true,
  "vendor": true,
  "dist": true,
  "build": true,
  "out": true,
  ".next": true,
  ".nuxt": true,
  ".turbo": true,
  ".cache": true,
  "coverage": true,
  "__pycache__": true,
  ".venv": true,
  "venv": true,
  "target": true,
  ".arij-worktrees": true,
};

/**
 * Hard cap on reported files. The list travels to the client and is rendered
 * in one dialog; a runaway monorepo must not produce an unbounded payload.
 */
export const DOCUMENT_SCAN_MAX_FILES = 500;
