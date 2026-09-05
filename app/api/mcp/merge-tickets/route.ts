/**
 * POST /api/mcp/merge-tickets — the mcp__arij__merge_tickets tool.
 *
 * Folds one or more planning tickets into a single one that can be built in
 * one go: three near-duplicate Backlog entries for the same feature, a bug
 * that is really a slice of the epic below it. The target survives and grows;
 * every source is absorbed and then retired.
 *
 * "Absorbed" is meant literally, and it is what separates this from calling
 * discard_ticket three times:
 *
 *   - the source's user stories are MOVED to the target, keeping their
 *     acceptance criteria — the scope has to survive the merge or the merge
 *     silently drops work;
 *   - the source's USER-authored comments are re-pointed to the target. The
 *     user wrote them, so they are not the pass's to delete. Agent comments
 *     go with the source: they narrate a ticket that no longer exists;
 *   - dependency edges are re-pointed, so nothing the source waited for and
 *     nothing waiting on it is silently unblocked;
 *   - the source's full original text is posted on the target as an
 *     absorption comment before the delete — the durable tombstone;
 *   - and the agent may rewrite the target's title and description in the
 *     same call, because a merged ticket that still reads like only one of
 *     its halves is the actual deliverable failure here.
 *
 * Ordering matters and is not transactional: the re-pointing runs first and
 * the deletes last, so an interruption leaves a target that already owns
 * everything and a source that is merely still there — recoverable — rather
 * than the reverse. `createDependencies` emits SSE events, which must not be
 * fired from inside a transaction that can still roll back.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, max } from "drizzle-orm";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { db } from "@/lib/db";
import {
  epics,
  ticketComments,
  ticketDependencies,
  userStories,
} from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import {
  refinementReasonSchema,
  requireAgentSessionToken,
  requireRefinementSessionToken,
  resolveRefinementTicket,
  ticketLabel,
} from "@/lib/mcp/refinement";
import { createDependencies } from "@/lib/dependencies/crud";
import { CycleError } from "@/lib/dependencies/validation";
import { logWorkflowDecision } from "@/lib/workflow/transition-service";
import { emitTicketUpdated } from "@/lib/events/emit";
import { tryExportArjiJson } from "@/lib/sync/export";
import { recordRefinementChange } from "@/lib/refinement/registry";
// Shared with the shim's advertised `maxItems` through the shim test.
import { MAX_MERGE_SOURCES } from "@/lib/refinement/constants";
import {
  captureTicketSnapshot,
  carryTicketUploads,
  formatTicketSnapshot,
  retireTicket,
  ticketRetirementGuard,
  type RetiredTicketSnapshot,
} from "@/lib/refinement/retire";

const bodySchema = z
  .object({
    ticket_id: z.string().min(1),
    source_ticket_ids: z.array(z.string().min(1)).min(1).max(MAX_MERGE_SOURCES),
    reason: refinementReasonSchema,
    /** Optional rewrite of the surviving ticket, for the merged scope. */
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(20000).optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  const agentOnly = requireAgentSessionToken(auth, "merge_tickets");
  if (agentOnly) return agentOnly;
  const refinementOnly = requireRefinementSessionToken(auth, "merge_tickets");
  if (refinementOnly) return refinementOnly;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const targetFound = resolveRefinementTicket(auth.projectId, body.ticket_id);
  if (isErrorResponse(targetFound)) return targetFound;
  const target = targetFound.epic;

  const sourceIds = Array.from(new Set(body.source_ticket_ids));
  if (sourceIds.includes(target.id)) {
    return NextResponse.json(
      {
        error: "A ticket cannot be merged into itself.",
        code: "SELF_MERGE",
      },
      { status: 400 }
    );
  }

  // Resolve and guard EVERY source before writing anything: a merge that
  // absorbs two tickets and then refuses the third has already destroyed
  // half of it, and there is nothing left to retry against.
  const sources: Array<typeof target> = [];
  for (const sourceId of sourceIds) {
    const found = resolveRefinementTicket(auth.projectId, sourceId);
    if (isErrorResponse(found)) return found;
    const historyGuard = ticketRetirementGuard(found.epic, "merge_tickets");
    if (historyGuard) return historyGuard;
    sources.push(found.epic);
  }

  const snapshots: RetiredTicketSnapshot[] = sources.map((source) =>
    captureTicketSnapshot(auth.projectId, source)
  );

  const now = new Date().toISOString();
  let storiesMoved = 0;
  let commentsMoved = 0;
  let imagesCarried = 0;
  let edgesRepointed = 0;
  const skippedEdges: string[] = [];

  let nextStoryPosition =
    (db
      .select({ highest: max(userStories.position) })
      .from(userStories)
      .where(eq(userStories.epicId, target.id))
      .get()?.highest ?? -1) + 1;

  for (const source of sources) {
    // --- stories -------------------------------------------------------
    const stories = db
      .select({ id: userStories.id, position: userStories.position })
      .from(userStories)
      .where(eq(userStories.epicId, source.id))
      .all()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    for (const story of stories) {
      db.update(userStories)
        .set({ epicId: target.id, position: nextStoryPosition++ })
        .where(eq(userStories.id, story.id))
        .run();
      storiesMoved++;
    }

    // --- screenshots -----------------------------------------------------
    // Before the comments and the delete: `retireTicket` unlinks whatever
    // `chat_attachments` still points at the source.
    imagesCarried += carryTicketUploads(auth.projectId, source.id, {
      id: target.id,
      // Re-read rather than closed over: each source appends to the same
      // column, so a stale `target.images` would drop every carry but the
      // last.
      images:
        db
          .select({ images: epics.images })
          .from(epics)
          .where(eq(epics.id, target.id))
          .get()?.images ?? null,
    });

    // --- the user's own comments ----------------------------------------
    const moved = db
      .update(ticketComments)
      .set({ epicId: target.id })
      .where(
        and(
          eq(ticketComments.epicId, source.id),
          eq(ticketComments.author, "user")
        )
      )
      .run();
    commentsMoved += Number(moved.changes ?? 0);

    // --- dependency edges ------------------------------------------------
    const outgoing = db
      .select({ dependsOnTicketId: ticketDependencies.dependsOnTicketId })
      .from(ticketDependencies)
      .where(
        and(
          eq(ticketDependencies.projectId, auth.projectId),
          eq(ticketDependencies.ticketId, source.id)
        )
      )
      .all();

    const incoming = db
      .select({ ticketId: ticketDependencies.ticketId })
      .from(ticketDependencies)
      .where(
        and(
          eq(ticketDependencies.projectId, auth.projectId),
          eq(ticketDependencies.dependsOnTicketId, source.id)
        )
      )
      .all();

    const candidates = [
      ...outgoing
        .filter((edge) => edge.dependsOnTicketId !== target.id)
        // A prerequisite that is itself being absorbed needs no edge: it is
        // about to be deleted, so `T → B` would be created, counted, and
        // dropped again by B's own retire — and if B transitively depends on
        // T, refused as a cycle and reported as an edge the merge "could not
        // carry", which is worse than misleading.
        .filter((edge) => !sourceIds.includes(edge.dependsOnTicketId))
        .map((edge) => ({
          ticketId: target.id,
          dependsOnTicketId: edge.dependsOnTicketId,
        })),
      ...incoming
        .filter((edge) => edge.ticketId !== target.id)
        // A source that another source also points at needs no edge: that
        // dependent is about to be absorbed into the target too.
        .filter((edge) => !sourceIds.includes(edge.ticketId))
        .map((edge) => ({
          ticketId: edge.ticketId,
          dependsOnTicketId: target.id,
        })),
    ];

    for (const edge of candidates) {
      try {
        edgesRepointed += createDependencies(auth.projectId, [edge]).length;
      } catch (error) {
        // A re-pointed edge can close a cycle the original pair did not —
        // the target may already sit on the other side of it. Skipping the
        // edge and naming it beats failing a merge that is otherwise sound.
        if (error instanceof CycleError) {
          skippedEdges.push(
            `${edge.ticketId} → ${edge.dependsOnTicketId} (would create a cycle)`
          );
          continue;
        }
        throw error;
      }
    }
  }

  // --- the merged ticket's own text --------------------------------------
  const newTitle = body.title ?? target.title;
  // An explicit empty description is absence, stored as NULL like everywhere
  // else; an absent key leaves the target's own text alone.
  const newDescription =
    body.description !== undefined
      ? body.description.length > 0
        ? body.description
        : null
      : target.description;
  const rewrote =
    newTitle !== target.title || newDescription !== target.description;

  if (rewrote) {
    db.update(epics)
      .set({ title: newTitle, description: newDescription, updatedAt: now })
      .where(eq(epics.id, target.id))
      .run();
  }

  // --- the tombstone, before the delete ----------------------------------
  const absorbedLabels = snapshots.map((snapshot) => snapshot.label);
  const commentLines: string[] = [
    `**Merged ${absorbedLabels.join(", ")} into ${ticketLabel(target)}** by the refinement re-pass.`,
    "",
    `> ${body.reason}`,
    "",
  ];
  if (storiesMoved > 0) {
    commentLines.push(
      `${storiesMoved} user ${storiesMoved === 1 ? "story" : "stories"} moved onto this ticket.`,
      ""
    );
  }
  if (commentsMoved > 0) {
    commentLines.push(
      `${commentsMoved} of your ${commentsMoved === 1 ? "comment" : "comments"} moved onto this ticket.`,
      ""
    );
  }
  if (imagesCarried > 0) {
    commentLines.push(
      `${imagesCarried} ${imagesCarried === 1 ? "screenshot" : "screenshots"} carried onto this ticket.`,
      ""
    );
  }
  if (skippedEdges.length > 0) {
    commentLines.push(
      `Dependency edges not carried over: ${skippedEdges.join("; ")}.`,
      ""
    );
  }
  commentLines.push("---", "");
  for (const snapshot of snapshots) {
    commentLines.push(formatTicketSnapshot(snapshot), "");
  }
  const commentBody = commentLines.join("\n").trim();

  db.insert(ticketComments)
    .values({
      id: createId(),
      epicId: target.id,
      author: "agent",
      content: commentBody,
      agentSessionId: auth.sessionId,
      createdAt: now,
    })
    .run();

  logWorkflowDecision({
    projectId: auth.projectId,
    epicId: target.id,
    status: target.status ?? "backlog",
    actor: "agent",
    reason: `Absorbed ${absorbedLabels.join(", ")} — ${body.reason}`,
    sessionId: auth.sessionId,
  });

  // --- and only now, the deletes -----------------------------------------
  for (const source of sources) {
    retireTicket(auth.projectId, source.id);
  }

  emitTicketUpdated(auth.projectId, target.id, {
    title: newTitle,
    merged: absorbedLabels,
  });

  // Deliberately no `snapshot`: the absorption comment above already carries
  // the sources' full text, on this very ticket. Repeating it in the recap
  // comment — which usually lands on the same ticket, since a merge target is
  // first among the pass's structural changes — would publish every absorbed
  // story's acceptance criteria twice in one feed, into the table the board's
  // status poll reads. A discard has no such comment, which is why its record
  // keeps its snapshot.
  recordRefinementChange(auth, {
    kind: "merged",
    ticketId: target.id,
    label: ticketLabel(target),
    detail: `absorbed ${absorbedLabels.join(", ")}`,
    reason: body.reason,
  });

  tryExportArjiJson(auth.projectId);

  return NextResponse.json({
    data: {
      ticketId: target.id,
      ticket: ticketLabel(target),
      title: newTitle,
      absorbed: snapshots.map((snapshot) => ({
        ticketId: snapshot.id,
        ticket: snapshot.label,
        title: snapshot.title,
      })),
      storiesMoved,
      commentsMoved,
      imagesCarried,
      dependencyEdgesRepointed: edgesRepointed,
      skippedEdges,
    },
  });
}
