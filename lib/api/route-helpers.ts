import { compositeAgentErrorResponse } from "./agent-resolution-response";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, epics, userStories } from "@/lib/db/schema";

/**
 * Shared helpers for App Router API routes.
 *
 * Response envelope contract (all routes must follow this):
 * - Success: `NextResponse.json({ data })` — extra payload keys live INSIDE
 *   `data`, never as siblings of it.
 * - Error: `NextResponse.json({ error, code?, ... })` — `error` is ALWAYS the
 *   human-readable message, never a bare machine code. Add `code` (a
 *   MACHINE_CODE string) or other structured fields only when a client
 *   actually consumes them.
 * - Status codes: 400 malformed/invalid input; 404 via the *Or404 helpers;
 *   409 concurrency conflicts (see createAgentAlreadyRunningPayload);
 *   422 reserved for the existing semantic dependency-cycle errors;
 *   500 unexpected failures via `errorResponse`.
 *
 * Usage in a handler:
 * ```ts
 * const found = getEpicOr404(projectId, epicId);
 * if (isErrorResponse(found)) return found;
 * const { epic } = found;
 * ```
 */

type Project = typeof projects.$inferSelect;
type Epic = typeof epics.$inferSelect;
type UserStory = typeof userStories.$inferSelect;

/** Type guard: true when a helper returned a ready-to-return error NextResponse. */
export function isErrorResponse<T>(
  result: T | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}

/**
 * Look up a project by id. Returns `{ project }` or a ready 404 response.
 * With `requireGitRepo`, also returns a 400 response when the project has no
 * `gitRepoPath` configured (and narrows the type so `gitRepoPath` is a string).
 */
export function getProjectOr404(
  projectId: string,
  opts: { requireGitRepo: true }
): { project: Project & { gitRepoPath: string } } | NextResponse;
export function getProjectOr404(
  projectId: string,
  opts?: { requireGitRepo?: boolean }
): { project: Project } | NextResponse;
export function getProjectOr404(
  projectId: string,
  opts?: { requireGitRepo?: boolean }
): { project: Project } | NextResponse {
  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (opts?.requireGitRepo && !project.gitRepoPath) {
    return NextResponse.json(
      { error: "Project has no git repository path configured" },
      { status: 400 }
    );
  }

  return { project };
}

/**
 * Look up an epic scoped to a project (`WHERE id = ? AND project_id = ?`).
 * Returns `{ epic }` or a ready 404 response. The project scoping is
 * intentional: an epicId from another project must 404, not resolve.
 */
export function getEpicOr404(
  projectId: string,
  epicId: string
): { epic: Epic } | NextResponse {
  const epic = db
    .select()
    .from(epics)
    .where(and(eq(epics.id, epicId), eq(epics.projectId, projectId)))
    .get();

  if (!epic) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  return { epic };
}

/**
 * Look up a user story scoped to a project (stories carry no project_id, so
 * scoping goes through the parent epic). Returns `{ story }` or a ready 404.
 */
export function getStoryOr404(
  projectId: string,
  storyId: string
): { story: UserStory } | NextResponse {
  const row = db
    .select({ story: userStories })
    .from(userStories)
    .innerJoin(epics, eq(userStories.epicId, epics.id))
    .where(and(eq(userStories.id, storyId), eq(epics.projectId, projectId)))
    .get();

  if (!row) {
    return NextResponse.json({ error: "Story not found" }, { status: 404 });
  }

  return { story: row.story };
}

/**
 * Shared catch-block helper: `{ error: message }` with the given status
 * (default 500). Uses the thrown Error's message when available, otherwise
 * the provided human-readable fallback.
 */
export function errorResponse(
  error: unknown,
  fallback: string,
  status = 500
): NextResponse {
  const resolutionError = compositeAgentErrorResponse(error);
  if (resolutionError) return resolutionError;
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status }
  );
}
