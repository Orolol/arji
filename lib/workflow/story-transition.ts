/**
 * Story-scoped status moves for the agent tool channel.
 *
 * `applyTransition` is epic-keyed by construction — every workflow guard, the
 * activity log and the SSE payloads all speak epic. That is correct for the
 * board, but it left the MCP `update_ticket_status` tool with no way to
 * express "my story is done": a story-scoped session calling it moved the
 * WHOLE EPIC, dragging every unfinished sibling into review behind it. On
 * E-arij-096 an agent hit exactly that and had to notice and undo it by hand:
 *
 *   "Reverting: the previous transition targeted the parent epic by default,
 *    not this session's story."
 *
 * When it is not noticed, the epic reaches review while siblings are still
 * being built, a review is dispatched against half-finished work, and the
 * inevitable "changes requested" sends everything back — feeding the very
 * loop this ticket ran in.
 *
 * The promotion rule here is the pipeline's, deliberately: a story move
 * carries the epic to `review` only once every sibling is review/done
 * (lib/pipeline/stages.ts, finalizeBuildSession). Keeping the two in step
 * matters more than the small duplication — an agent announcing its story
 * through the tool channel must land the board in the same state as the
 * pipeline finishing that same story.
 */

import { and, eq } from "drizzle-orm";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import { epics, userStories } from "@/lib/db/schema";
import type { KanbanStatus } from "@/lib/types/kanban";

export interface StoryTransitionResult {
  valid: boolean;
  error?: string;
  fromStatus?: KanbanStatus;
  /** True when this move also carried the parent epic to `review`. */
  promotedEpic?: boolean;
  epicFromStatus?: KanbanStatus;
}

/** Statuses that count as "this story is off the build queue". */
const SETTLED_STORY_STATUSES = new Set(["review", "done"]);

/**
 * Moves one story and, when that completes the set, promotes the parent epic.
 *
 * Returns `valid: false` with a readable message rather than throwing — the
 * caller is a tool route whose errors are read by an agent.
 */
export function applyStoryTransition(opts: {
  storyId: string;
  epicId: string;
  toStatus: KanbanStatus;
  database?: ArijDatabase;
}): StoryTransitionResult {
  const { storyId, epicId, toStatus } = opts;
  const database = opts.database ?? defaultDb;

  const story = database
    .select()
    .from(userStories)
    .where(and(eq(userStories.id, storyId), eq(userStories.epicId, epicId)))
    .get();

  if (!story) {
    return { valid: false, error: "Story not found on this session's ticket" };
  }

  const fromStatus = (story.status ?? "backlog") as KanbanStatus;
  if (fromStatus === toStatus) {
    return { valid: true, fromStatus, promotedEpic: false };
  }

  // `done` on a story is the human's call, exactly as review→done is on an
  // epic: the tool channel may carry work up to review and no further.
  if (toStatus === "done") {
    return {
      valid: false,
      error:
        "Cannot move a story to Done from an agent session. Move it to Review; " +
        "an epic reaches Done through the human approve/merge flow.",
    };
  }

  database
    .update(userStories)
    .set({ status: toStatus })
    .where(eq(userStories.id, storyId))
    .run();

  if (toStatus !== "review") {
    return { valid: true, fromStatus, promotedEpic: false };
  }

  // Promotion check reads the freshly-written row along with its siblings, so
  // the last story to settle is the one that carries the epic.
  const siblings = database
    .select()
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .all();
  const allSettled = siblings.every((sibling) =>
    SETTLED_STORY_STATUSES.has(sibling.status ?? "")
  );
  if (!allSettled) {
    return { valid: true, fromStatus, promotedEpic: false };
  }

  const epic = database
    .select()
    .from(epics)
    .where(eq(epics.id, epicId))
    .get();
  const epicFromStatus = (epic?.status ?? "backlog") as KanbanStatus;
  if (epicFromStatus === "review" || epicFromStatus === "done") {
    return { valid: true, fromStatus, promotedEpic: false };
  }

  database
    .update(epics)
    .set({ status: "review", updatedAt: new Date().toISOString() })
    .where(eq(epics.id, epicId))
    .run();

  return { valid: true, fromStatus, promotedEpic: true, epicFromStatus };
}
