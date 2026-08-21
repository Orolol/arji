/**
 * Reading side of the screenshots the bug creation modal attaches.
 *
 * `POST /api/projects/:id/bugs` stores them in `epics.images` as a JSON array
 * of repo-relative upload paths (`data/uploads/<projectId>/<file>`). That
 * column is free-form text, it predates this feature, and it is written
 * straight from the request body — so everything here treats it as untrusted:
 * malformed JSON, a bare string, nulls inside the array, and paths pointing
 * anywhere other than this project's upload directory all normalise to "no
 * image" instead of to a broken thumbnail.
 *
 * Client-safe: no `db`, no `fs`, no Next.js import. The ticket panel and the
 * route that serves the bytes both read the rules from here, so the URL the UI
 * asks for cannot drift from the path the route will accept.
 */

export interface TicketImage {
  /** Path exactly as stored in `epics.images`. */
  path: string;
  /** Name on disk; also the last segment of `url`. */
  fileName: string;
  /** Where the browser fetches the bytes. */
  url: string;
}

/** Repo-relative directory `POST /chat/upload` writes a project's files to. */
export function uploadsDirectoryFor(projectId: string): string {
  return `data/uploads/${projectId}`;
}

/**
 * Whether a name may be looked up inside a project's upload directory.
 *
 * A dynamic route segment arrives already percent-decoded, so `%2F` reaches
 * the handler as a real separator. Names carrying one are rejected outright
 * rather than trimmed or resolved — there is no legitimate upload whose name
 * contains a separator, and refusing is the one behaviour that cannot be
 * walked out of the directory.
 */
export function isServableUploadFileName(fileName: unknown): fileName is string {
  if (typeof fileName !== "string") return false;
  if (fileName.length === 0 || fileName === "." || fileName === "..") return false;
  return !/[/\\\0]/.test(fileName);
}

/** URL of the route that serves one of a project's uploaded images. */
export function ticketImageUrl(projectId: string, fileName: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(
    fileName
  )}`;
}

/**
 * The on-disk file name a stored path points at, or `null` when the path is
 * not one of this project's uploads.
 */
export function uploadFileNameFromPath(
  storedPath: unknown,
  projectId: string
): string | null {
  if (typeof storedPath !== "string") return null;

  const trimmed = storedPath.trim();
  const withoutDotSlash = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;

  const prefix = `${uploadsDirectoryFor(projectId)}/`;
  if (!withoutDotSlash.startsWith(prefix)) return null;

  const fileName = withoutDotSlash.slice(prefix.length);
  return isServableUploadFileName(fileName) ? fileName : null;
}

/** Whatever the column holds, reduced to the list of strings it meant. */
function storedImagePaths(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The displayable images a ticket carries. Order is preserved and duplicates
 * are kept — this reports what is stored, it does not curate it.
 */
export function parseTicketImages(raw: unknown, projectId: string): TicketImage[] {
  const images: TicketImage[] = [];

  for (const entry of storedImagePaths(raw)) {
    const fileName = uploadFileNameFromPath(entry, projectId);
    if (!fileName) continue;
    images.push({
      path: entry as string,
      fileName,
      url: ticketImageUrl(projectId, fileName),
    });
  }

  return images;
}
