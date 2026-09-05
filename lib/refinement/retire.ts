/**
 * Retiring a planning ticket — the half `discard_ticket` and `merge_tickets`
 * share.
 *
 * Both tools end with a ticket leaving the board for good, and "for good" is
 * the load-bearing word: Arij has no archived column, so the row goes through
 * `deleteEpicPermanently`, the same primitive the UI's delete button runs.
 * That is destructive, an agent is the one asking for it, and the board is
 * the user's. Three things make it defensible, and all three live here:
 *
 *   1. **A ticket an agent has ever run on is refused.** Deleting it would
 *      take its `agent_sessions` rows with it — transcripts, outcomes and
 *      usage figures the user cannot reconstruct (see
 *      lib/planning/permanent-delete.ts, which deletes the sessions and their
 *      comments as part of the ticket). A planning pass has no business
 *      spending that history; the user's own delete button still reaches
 *      those tickets.
 *   2. **Nothing leaves without a tombstone.** `captureTicketSnapshot` reads
 *      the whole ticket *before* the delete, and every caller persists
 *      `formatTicketSnapshot` somewhere durable — the absorption comment on
 *      the merge target, the end-of-run recap comment for a discard. A user
 *      who disagrees with the call can retype the ticket from it.
 *   3. **A mandatory justification**, like every other refinement write
 *      (lib/mcp/refinement.ts) — recorded next to the tombstone.
 *
 * The Backlog/To do guardrail is not re-implemented here: callers resolve
 * their tickets through `resolveRefinementTicket`, which is the one place
 * that rule lives.
 */

import { and, eq, inArray, or } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  agentSessions,
  chatAttachments,
  epics,
  ticketDependencies,
  userStories,
} from "@/lib/db/schema";
import { storedTicketImagePaths } from "@/lib/uploads/ticket-images";
import { emitTicketDeleted } from "@/lib/events/emit";
import { deleteEpicPermanently } from "@/lib/planning/permanent-delete";
import { REFINEMENT_STATUSES, ticketLabel } from "@/lib/mcp/refinement";

type Epic = typeof epics.$inferSelect;

export interface RetiredStorySnapshot {
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
}

/**
 * Everything about a ticket that the delete is about to destroy, read while
 * the rows still exist.
 */
export interface RetiredTicketSnapshot {
  id: string;
  label: string;
  title: string;
  type: string;
  status: string;
  priority: number;
  description: string | null;
  stories: RetiredStorySnapshot[];
  /** Readable labels of what it depended on, for the tombstone text. */
  dependsOn: string[];
  /** Readable labels of the tickets that depended on it. */
  blockedTickets: string[];
  /**
   * The ticket's stored screenshot paths.
   *
   * A bug filed through the bug form owns real files under `data/uploads/`,
   * and `deleteEpicPermanently` unlinks them — so on a discard this list is
   * the only record that the evidence ever existed, and the tombstone has to
   * say so. On a merge they are carried to the survivor instead
   * (`carryTicketUploads`) and nothing is unlinked.
   */
  images: string[];
}

/** Has any agent session ever been attached to this ticket or its stories? */
export function ticketHasAgentSessions(epicId: string): boolean {
  const storyIds = db
    .select({ id: userStories.id })
    .from(userStories)
    .where(eq(userStories.epicId, epicId))
    .all()
    .map((row) => row.id);

  const session = db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      storyIds.length > 0
        ? or(
            eq(agentSessions.epicId, epicId),
            inArray(agentSessions.userStoryId, storyIds),
          )
        : eq(agentSessions.epicId, epicId),
    )
    .get();

  return Boolean(session);
}

/**
 * The tickets that depend on this one and are still WAITING on it.
 *
 * Scoped to the planning columns, and both halves of that matter:
 *
 *   - a dependent already in `in_progress` or beyond has passed the
 *     dependency gate — it is running, reviewed or shipped, and deleting its
 *     prerequisite cannot unblock work that never started. Its edge is
 *     history, and `retireTicket` drops it with the row;
 *   - it is also the only set `remove_dependency` can act on. That route
 *     holds the DEPENDENT to the Backlog/To do guardrail (deliberately, see
 *     its own comment), so blocking a discard on a dependent the agent
 *     cannot detach was a closed loop: the 409 named a remedy that answered
 *     409 in turn, and the ticket was undiscardable by any refinement pass.
 */
export function ticketDependents(projectId: string, epicId: string): Epic[] {
  const rows = db
    .select({ ticketId: ticketDependencies.ticketId })
    .from(ticketDependencies)
    .where(
      and(
        eq(ticketDependencies.projectId, projectId),
        eq(ticketDependencies.dependsOnTicketId, epicId),
      ),
    )
    .all();

  if (rows.length === 0) return [];

  return db
    .select()
    .from(epics)
    .where(
      and(
        eq(epics.projectId, projectId),
        inArray(epics.status, [...REFINEMENT_STATUSES]),
        inArray(
          epics.id,
          rows.map((row) => row.ticketId),
        ),
      ),
    )
    .all();
}

/**
 * 409 when the ticket carries agent history; null when it may be retired.
 *
 * Deliberately a *session* check rather than a status check: the Backlog/To
 * do guardrail already ran, and a planning-column ticket can still carry a
 * failed build, a question that was answered, or a pass that was sent back —
 * all of which are the user's record of what happened, not the agent's to
 * delete.
 */
export function ticketRetirementGuard(
  epic: Epic,
  toolName: string,
): NextResponse | null {
  if (!ticketHasAgentSessions(epic.id)) return null;
  return NextResponse.json(
    {
      error: `${ticketLabel(epic)} has agent session history — ${toolName} cannot delete it, because the sessions and their transcripts would go with it. Leave it on the board and say why in a comment instead.`,
      code: "TICKET_HAS_SESSIONS",
    },
    { status: 409 },
  );
}

/** Read the whole ticket, before the delete destroys it. */
export function captureTicketSnapshot(
  projectId: string,
  epic: Epic,
): RetiredTicketSnapshot {
  const stories = db
    .select({
      title: userStories.title,
      description: userStories.description,
      acceptanceCriteria: userStories.acceptanceCriteria,
      position: userStories.position,
    })
    .from(userStories)
    .where(eq(userStories.epicId, epic.id))
    .all()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const edges = db
    .select({
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
    })
    .from(ticketDependencies)
    .where(
      and(
        eq(ticketDependencies.projectId, projectId),
        or(
          eq(ticketDependencies.ticketId, epic.id),
          eq(ticketDependencies.dependsOnTicketId, epic.id),
        ),
      ),
    )
    .all();

  const referenced = Array.from(
    new Set(
      edges.flatMap((edge) => [edge.ticketId, edge.dependsOnTicketId]),
    ),
  ).filter((id) => id !== epic.id);

  const labels = new Map<string, string>();
  if (referenced.length > 0) {
    for (const row of db
      .select({ id: epics.id, readableId: epics.readableId })
      .from(epics)
      .where(inArray(epics.id, referenced))
      .all()) {
      labels.set(row.id, row.readableId ?? row.id);
    }
  }

  return {
    id: epic.id,
    label: ticketLabel(epic),
    title: epic.title ?? "(untitled)",
    type: epic.type ?? "feature",
    status: epic.status ?? "backlog",
    priority: epic.priority ?? 0,
    description: epic.description?.trim() || null,
    stories: stories.map((story) => ({
      title: story.title ?? "(untitled story)",
      description: story.description?.trim() || null,
      acceptanceCriteria: story.acceptanceCriteria?.trim() || null,
    })),
    dependsOn: edges
      .filter((edge) => edge.ticketId === epic.id)
      .map((edge) => labels.get(edge.dependsOnTicketId) ?? edge.dependsOnTicketId),
    blockedTickets: edges
      .filter((edge) => edge.dependsOnTicketId === epic.id)
      .map((edge) => labels.get(edge.ticketId) ?? edge.ticketId),
    images: storedTicketImagePaths(epic.images).filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    ),
  };
}

/**
 * Move a ticket's screenshots to another ticket, before the first one is
 * deleted.
 *
 * Both halves matter and they are stored separately: `epics.images` is what
 * the ticket surface renders and what the prompt builder reads, while the
 * `chat_attachments` row is what OWNS the bytes — `deleteEpicPermanently`
 * reads that row for the file path and unlinks it. Re-pointing the row
 * without copying the path would leave the survivor with files nothing
 * displays; copying the path without re-pointing the row would have the
 * source's delete unlink files the survivor now shows.
 *
 * Returns how many image paths were carried over.
 */
export function carryTicketUploads(
  projectId: string,
  fromEpicId: string,
  toEpic: Pick<Epic, "id" | "images">,
): number {
  const source = db
    .select({ images: epics.images })
    .from(epics)
    .where(eq(epics.id, fromEpicId))
    .get();

  const carried = storedTicketImagePaths(source?.images).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );

  // The row move runs even with no `epics.images` entry: an attachment can be
  // owned by a ticket whose column was written by another path, and an
  // orphaned row would take its file down with the source.
  db.update(chatAttachments)
    .set({ epicId: toEpic.id, projectId })
    .where(eq(chatAttachments.epicId, fromEpicId))
    .run();

  if (carried.length === 0) return 0;

  const existing = storedTicketImagePaths(toEpic.images).filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  const merged = [...existing];
  for (const path of carried) {
    if (!merged.includes(path)) merged.push(path);
  }

  db.update(epics)
    .set({ images: JSON.stringify(merged), updatedAt: new Date().toISOString() })
    .where(eq(epics.id, toEpic.id))
    .run();

  return carried.length;
}

/**
 * The tombstone, as markdown.
 *
 * Verbose on purpose: this is the only surviving copy of the ticket once the
 * row is gone, so it carries the description and every story's acceptance
 * criteria rather than a one-line summary. It is written into a comment on a
 * ticket that survives, which is what keeps it readable and durable.
 */
export function formatTicketSnapshot(snapshot: RetiredTicketSnapshot): string {
  const lines: string[] = [
    `**${snapshot.label} — ${snapshot.title}** (${snapshot.type}, priority ${snapshot.priority}, was in ${snapshot.status})`,
    "",
  ];

  if (snapshot.description) {
    lines.push(snapshot.description, "");
  }

  if (snapshot.stories.length > 0) {
    lines.push("Stories:", "");
    for (const story of snapshot.stories) {
      lines.push(`- **${story.title}**`);
      if (story.description) lines.push(`  - ${story.description}`);
      if (story.acceptanceCriteria) {
        lines.push(`  - Acceptance criteria: ${story.acceptanceCriteria}`);
      }
    }
    lines.push("");
  }

  if (snapshot.dependsOn.length > 0) {
    lines.push(`Depended on: ${snapshot.dependsOn.join(", ")}`, "");
  }
  if (snapshot.blockedTickets.length > 0) {
    lines.push(`Blocked: ${snapshot.blockedTickets.join(", ")}`, "");
  }
  if (snapshot.images.length > 0) {
    // Named, not just counted: on a discard the files are unlinked with the
    // row, so this list is the only surviving trace that the evidence was
    // ever attached.
    lines.push(
      `Screenshots (${snapshot.images.length}): ${snapshot.images.join(", ")}`,
      "",
    );
  }

  return lines.join("\n").trim();
}

/**
 * Drop every dependency edge touching the ticket, then delete it and
 * announce the removal.
 *
 * The edges are deleted explicitly rather than left to the FK cascade for the
 * reason `deleteEpicPermanently` already states about chat attachments: the
 * cascade only fires when the connection's `foreign_keys` pragma is on, and
 * an orphan edge outlives the ticket it points at, permanently blocking its
 * dependent.
 */
export function retireTicket(projectId: string, epicId: string): void {
  db.delete(ticketDependencies)
    .where(
      and(
        eq(ticketDependencies.projectId, projectId),
        or(
          eq(ticketDependencies.ticketId, epicId),
          eq(ticketDependencies.dependsOnTicketId, epicId),
        ),
      ),
    )
    .run();

  deleteEpicPermanently(projectId, epicId);
  emitTicketDeleted(projectId, epicId);
}
