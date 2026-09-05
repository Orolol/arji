/**
 * POST /api/mcp/create-planning-ticket — the
 * mcp__arij__create_planning_ticket tool.
 *
 * The refinement pass's answer to a gap: reading the board end to end is
 * exactly when a missing piece of work becomes obvious, and without this the
 * pass could only describe it in a comment nobody converts into a ticket.
 *
 * Deliberately NOT the chat toolset's `create_ticket`. That one is a general
 * board writer reachable from a conversation; this one lands in a planning
 * column, carries the same mandatory justification as every other refinement
 * write, is capped per pass, and refuses a title the board already has —
 * because "something is missing" is false if it is already there.
 *
 * The insert is written here rather than proxied to the canonical epics
 * route (the path `create_bug` takes) because the pass needs the refinement
 * justification in `ticket_activity_log`, and the canonical route only
 * writes an attribution entry for the create_bug contract. The primitives it
 * uses are the same ones: `generateReadableId` inside the transaction,
 * `emitTicketCreated`, `tryExportArjiJson`.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody } from "@/lib/validation/validate";
import { db } from "@/lib/db";
import { epics, projects, userStories } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import { generateReadableId } from "@/lib/db/readable-id";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import {
  REFINEMENT_STATUSES,
  refinementReasonSchema,
  requireAgentSessionToken,
  requireRefinementSessionToken,
} from "@/lib/mcp/refinement";
// Named for its first caller; the normalisation (case, accents, punctuation,
// whitespace) is title-generic and is the project's one duplicate-title key.
import { normalizeBugTitle as normalizeTitleKey } from "@/lib/mcp/create-bug";
import { logWorkflowDecision } from "@/lib/workflow/transition-service";
import { emitTicketCreated } from "@/lib/events/emit";
import { tryExportArjiJson } from "@/lib/sync/export";
import {
  peekRefinementChanges,
  recordRefinementChange,
} from "@/lib/refinement/registry";
// Shared with the shim's advertised cap through the shim test.
import { MAX_REFINEMENT_CREATED_TICKETS } from "@/lib/refinement/constants";

const bodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20000).optional(),
    type: z.enum(["feature", "bug"]).optional(),
    priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
    status: z.enum(REFINEMENT_STATUSES).optional(),
    user_stories: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(300),
            description: z.string().trim().max(4000).optional(),
            acceptance_criteria: z.string().trim().max(8000).optional(),
          })
          .strict()
      )
      .max(20)
      .optional(),
    reason: refinementReasonSchema,
  })
  .strict();

/** Blank prose is absence, stored as NULL rather than "". */
function orNull(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  const agentOnly = requireAgentSessionToken(auth, "create_planning_ticket");
  if (agentOnly) return agentOnly;
  const refinementOnly = requireRefinementSessionToken(
    auth,
    "create_planning_ticket"
  );
  if (refinementOnly) return refinementOnly;

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;
  const body = validated.data;

  const project = db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, auth.projectId))
    .get();
  if (!project) {
    return NextResponse.json(
      { error: "Project not found", code: "PROJECT_NOT_FOUND" },
      { status: 404 }
    );
  }

  const alreadyCreated = peekRefinementChanges(auth.sessionId).filter(
    (change) => change.kind === "created"
  ).length;
  if (alreadyCreated >= MAX_REFINEMENT_CREATED_TICKETS) {
    return NextResponse.json(
      {
        error: `This refinement pass has already created ${MAX_REFINEMENT_CREATED_TICKETS} tickets. Post a comment describing anything else that is missing instead.`,
        code: "CREATION_LIMIT_REACHED",
      },
      { status: 429 }
    );
  }

  // "Missing" is a claim about the board, so check the board. Only undelivered
  // tickets count: a feature that shipped can legitimately need a follow-up
  // under the same name.
  const titleKey = normalizeTitleKey(body.title);
  const duplicate = db
    .select({
      id: epics.id,
      readableId: epics.readableId,
      title: epics.title,
      status: epics.status,
    })
    .from(epics)
    .where(
      and(
        eq(epics.projectId, auth.projectId),
        notInArray(epics.status, ["done", "released"])
      )
    )
    .all()
    .find((row) => normalizeTitleKey(row.title) === titleKey);

  if (duplicate) {
    return NextResponse.json(
      {
        error: `${duplicate.readableId ?? duplicate.id} already covers "${duplicate.title}" (${duplicate.status ?? "backlog"}).`,
        code: "DUPLICATE_TICKET",
        existing_ticket: {
          id: duplicate.id,
          readable_id: duplicate.readableId,
          title: duplicate.title,
          status: duplicate.status,
        },
      },
      { status: 409 }
    );
  }

  const status = body.status ?? "backlog";
  const type = body.type ?? "feature";
  const now = new Date().toISOString();
  const id = createId();

  const maxPosition = db
    .select({ highest: sql<number>`COALESCE(MAX(position), -1)` })
    .from(epics)
    .where(and(eq(epics.projectId, auth.projectId), eq(epics.status, status)))
    .get();

  const stories = (body.user_stories ?? []).map((story, index) => ({
    id: createId(),
    epicId: id,
    title: story.title,
    description: orNull(story.description),
    acceptanceCriteria: orNull(story.acceptance_criteria),
    status: "todo",
    position: index,
    createdAt: now,
  }));

  let readableId: string | null = null;
  db.transaction((tx) => {
    // Inside the transaction for the reason the canonical epics route states:
    // it bumps `projects.ticket_counter`, and a rolled-back insert must not
    // burn a readable id on a ticket that never existed.
    readableId = generateReadableId(auth.projectId, project.name, type);
    tx.insert(epics)
      .values({
        id,
        projectId: auth.projectId,
        title: body.title,
        description: orNull(body.description),
        priority: body.priority ?? 0,
        status,
        position: (maxPosition?.highest ?? -1) + 1,
        createdAt: now,
        updatedAt: now,
        type,
        readableId,
      })
      .run();
    if (stories.length > 0) {
      tx.insert(userStories).values(stories).run();
    }
  });

  const label = readableId ?? id;

  // Same-state decision entry: why a ticket the user never asked for exists.
  logWorkflowDecision({
    projectId: auth.projectId,
    epicId: id,
    status,
    actor: "agent",
    reason: `Created by the refinement re-pass — ${body.reason}`,
    sessionId: auth.sessionId,
  });

  recordRefinementChange(auth, {
    kind: "created",
    ticketId: id,
    label,
    detail: `new ${type} in ${status === "todo" ? "To do" : "Backlog"} — "${body.title}"`,
    reason: body.reason,
  });

  emitTicketCreated(auth.projectId, id, body.title);
  tryExportArjiJson(auth.projectId);

  return NextResponse.json(
    {
      data: {
        ticketId: id,
        ticket: label,
        title: body.title,
        type,
        status,
        priority: body.priority ?? 0,
        userStoriesCreated: stories.length,
      },
    },
    { status: 201 }
  );
}
