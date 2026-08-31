/**
 * Server-side half of the ticket screenshot pipeline: turning the paths stored
 * in `epics.images` into something an agent can open.
 *
 * `lib/uploads/ticket-images.ts` stays client-safe and speaks in repo-relative
 * paths (`data/uploads/<projectId>/<file>`) because that is what the browser
 * needs. An agent needs the opposite: it is spawned with its cwd set to a git
 * worktree of the *user's project*, so a repo-relative path would resolve
 * inside that worktree and find nothing. This module is where the same stored
 * value becomes an absolute path, through the same `upload-paths.ts` helper
 * the route serving the bytes uses, so the prompt and the thumbnail can never
 * point at different files.
 *
 * Separate from `ticket-images.ts` precisely because `process.cwd()` has no
 * meaning in a browser bundle.
 */

import { parseTicketImages } from "./ticket-images";
import { uploadFileAbsolutePath } from "./upload-paths";

/**
 * Absolute paths of the screenshots a ticket carries, in stored order.
 *
 * `raw` is `epics.images` verbatim — free-form text written from a request
 * body — so everything the reading side rejects (malformed JSON, a bare
 * string, another project's uploads, a traversal attempt) is dropped here too
 * rather than handed to an agent as a file to read. A ticket with no usable
 * image yields an empty array, which callers render as no prompt section at
 * all.
 */
export function ticketImageAbsolutePaths(
  raw: unknown,
  projectId: string
): string[] {
  return parseTicketImages(raw, projectId).map((image) =>
    // Rebuilt from the validated file name rather than joined onto the stored
    // string: `parseTicketImages` accepts a leading `./` and surrounding
    // whitespace, and neither belongs in a path handed to an agent.
    uploadFileAbsolutePath(projectId, image.fileName)
  );
}
