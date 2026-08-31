/**
 * Rules shared by every surface that attaches images through
 * `POST /api/projects/:id/chat/upload` — today the chat composer and the bug
 * creation modal.
 *
 * The upload route imports the same constants and the same rejection reason,
 * so the limit the UI enforces cannot drift away from the limit the server
 * enforces. Client-safe: no `db`, no `fs`, no Next.js import.
 */

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** Value for an `<input type="file">` accept attribute. */
export const IMAGE_UPLOAD_ACCEPT = ALLOWED_IMAGE_MIME_TYPES.join(",");

/**
 * The application's own limit on one attached image.
 *
 * It must stay strictly below `experimental.proxyClientMaxBodySize` in
 * `next.config.ts`: `proxy.ts` matches `/api/:path*`, so Next buffers the
 * request body up to that cap, and a file at the same number overflows it once
 * the multipart envelope is added — the body then reaches the route truncated
 * and `imageUploadRejectionReason` never sees the file at all.
 */
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Derived, so the wording of the limit cannot drift away from the limit. */
export const MAX_IMAGE_UPLOAD_LABEL = `${MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024}MB`;

/**
 * How many screenshots one ticket may carry.
 *
 * Every entry becomes a thumbnail in the panel and a file path in the agent's
 * prompt, so an unbounded array is unbounded prompt. Ten is far above what a
 * bug report needs and low enough that neither surface can be flooded.
 */
export const MAX_TICKET_IMAGES = 10;

const ALLOWED_EXTENSIONS_LABEL = ALLOWED_IMAGE_MIME_TYPES.map((type) =>
  type.slice("image/".length)
).join(", ");

/** The parts of a `File` the rules actually look at. */
export interface ImageFileLike {
  name?: string;
  type: string;
  size: number;
}

export interface RejectedImageFile {
  fileName: string;
  reason: string;
}

export interface PartitionedImageFiles {
  accepted: File[];
  rejected: RejectedImageFile[];
}

export function isAllowedImageMimeType(type: string): boolean {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * Why an upload is refused, split by kind.
 *
 * The two kinds are not the same answer over HTTP: a file that is too big is
 * `413 Payload Too Large`, while a file of the wrong type is a `400`. Callers
 * that only need the wording use `imageUploadRejectionReason` below; the
 * upload route needs the distinction to pick a status.
 */
export type ImageUploadRejectionCode = "unsupported_type" | "too_large";

export interface ImageUploadRejection {
  code: ImageUploadRejectionCode;
  reason: string;
}

/**
 * Why this file cannot be uploaded, or `null` when it is acceptable.
 * The wording is what the upload route returns to API callers.
 */
export function imageUploadRejection(file: ImageFileLike): ImageUploadRejection | null {
  if (!isAllowedImageMimeType(file.type)) {
    return {
      code: "unsupported_type",
      reason: `Unsupported file type: ${file.type || "unknown"}. Allowed: ${ALLOWED_EXTENSIONS_LABEL}`,
    };
  }

  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    const megabytes = (file.size / 1024 / 1024).toFixed(1);
    return {
      code: "too_large",
      reason: `File too large (${megabytes}MB). Max: ${MAX_IMAGE_UPLOAD_LABEL}`,
    };
  }

  return null;
}

/** The rejection wording alone — one source of truth with the route's. */
export function imageUploadRejectionReason(file: ImageFileLike): string | null {
  return imageUploadRejection(file)?.reason ?? null;
}

/**
 * Why an upload whose multipart body could not be parsed is refused.
 *
 * A request body over the platform's cap reaches the route truncated, so
 * `request.formData()` throws before `imageUploadRejectionReason` ever sees
 * the file — the size guard above cannot be what answers that caller. This is
 * the wording used instead, and it names the same limit.
 *
 * `bodyBytes` is the request's declared `content-length` when it carried one.
 * It measures the whole multipart body, not the file alone, which is why the
 * message says so: a file of exactly the limit still overflows once the form
 * envelope is added, and "10.0MB. Max: 10MB" would otherwise read as a
 * contradiction.
 */
export function oversizedUploadReason(bodyBytes: number | null): string {
  if (bodyBytes === null) {
    return `Upload too large. Max: ${MAX_IMAGE_UPLOAD_LABEL}`;
  }

  const megabytes = (bodyBytes / 1024 / 1024).toFixed(1);
  return `Upload too large (${megabytes}MB including form overhead). Max: ${MAX_IMAGE_UPLOAD_LABEL}`;
}

/** Splits a batch into what may be uploaded and what must be reported back. */
export function partitionImageFiles(files: Iterable<File>): PartitionedImageFiles {
  const accepted: File[] = [];
  const rejected: RejectedImageFile[] = [];

  for (const file of files) {
    const reason = imageUploadRejectionReason(file);
    if (reason) {
      rejected.push({ fileName: file.name || "file", reason });
    } else {
      accepted.push(file);
    }
  }

  return { accepted, rejected };
}

/** One user-facing line naming every refused file and why. */
export function formatImageRejections(rejected: RejectedImageFile[]): string | null {
  if (rejected.length === 0) return null;
  return rejected.map((entry) => `${entry.fileName}: ${entry.reason}`).join(" · ");
}

interface ClipboardItemLike {
  type: string;
  getAsFile: () => File | null;
}

interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | Iterable<ClipboardItemLike> | null;
  files?: ArrayLike<File> | Iterable<File> | null;
}

function toArray<T>(value: ArrayLike<T> | Iterable<T> | null | undefined): T[] {
  if (!value) return [];
  return Array.from(value as ArrayLike<T>);
}

/**
 * Clipboard images carry no meaningful file name, so they are renamed to
 * something stable and readable. Index-suffixed so a multi-image paste does
 * not produce several files with the same name.
 */
function renamePastedImage(file: File, index: number, timestamp: number): File {
  const extension = file.type.split("/")[1] || "png";
  const suffix = index > 0 ? `-${index + 1}` : "";
  return new File([file], `pasted-image-${timestamp}${suffix}.${extension}`, {
    type: file.type,
  });
}

/**
 * Files carried by a paste event. Returns an empty array for a text-only
 * paste, which is how callers know to leave the event alone.
 *
 * Non-image files are returned as-is rather than dropped, so the caller can
 * tell the user *why* nothing was attached instead of failing silently.
 */
export function imageFilesFromClipboard(
  clipboardData: ClipboardDataLike | null | undefined,
  timestamp: number = Date.now()
): File[] {
  if (!clipboardData) return [];

  const fromItems = toArray(clipboardData.items)
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  const files = fromItems.length > 0 ? fromItems : toArray(clipboardData.files);

  return files.map((file, index) =>
    file.type.startsWith("image/") ? renamePastedImage(file, index, timestamp) : file
  );
}

/** Files carried by a drop event. */
export function imageFilesFromDrop(
  dataTransfer: { files?: ArrayLike<File> | Iterable<File> | null } | null | undefined
): File[] {
  return toArray(dataTransfer?.files);
}
