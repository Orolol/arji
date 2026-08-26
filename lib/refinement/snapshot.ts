/**
 * The board snapshot a refinement re-pass works from.
 *
 * Split in two on purpose: `assembleRefinementSnapshot` is pure and unit
 * tested directly, `loadRefinementSnapshot` is the thin database read that
 * feeds it. The derived board state (column order, dependency readiness,
 * unanswered questions) is computed once, here, so the prompt and any future
 * UI read the same thing rather than each re-deriving its own view.
 *
 * Ordering comes from the board's `position` column and nothing else. That
 * is the same source drag-and-drop writes and the same one the reorder tool
 * writes; re-deriving an order from status, priority or timestamps would be
 * a second ranking that drifts silently against the board the user sees.
 */

import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  ticketComments,
  ticketDependencies,
  userStories,
} from "@/lib/db/schema";
import { isAwaitingReply } from "@/lib/kanban/awaiting-reply";
import { isDeliveredStatus } from "@/lib/types/kanban";
import { REFINEMENT_STATUSES, type RefinementStatus } from "@/lib/mcp/refinement";

/** A dependency edge as the re-pass sees it: the target and its column. */
export interface RefinementDependency {
  ticketId: string;
  label: string;
  status: string;
  /** True once the dependency can no longer block work (done or released). */
  satisfied: boolean;
}

export interface RefinementStory {
  id: string;
  title: string;
  hasAcceptanceCriteria: boolean;
  acceptanceCriteria: string | null;
}

export interface RefinementTicket {
  id: string;
  label: string;
  title: string;
  type: string;
  status: RefinementStatus;
  priority: number;
  position: number;
  description: string | null;
  stories: RefinementStory[];
  dependsOn: RefinementDependency[];
  /** Planning tickets that wait on this one — the cost of leaving it stuck. */
  blocks: RefinementDependency[];
  /**
   * The last session on this ticket ended by asking the user something and
   * no user comment has landed since. Refinement must not "fix" these by
   * moving them; the ticket is waiting on a human.
   */
  awaitingReply: boolean;
  /** Most recent agent question left on the ticket, when it is unanswered. */
  openQuestion: string | null;
}

export interface RefinementSnapshot {
  backlog: RefinementTicket[];
  todo: RefinementTicket[];
}

export interface RefinementSnapshotInput {
  epics: Array<{
    id: string;
    readableId: string | null;
    title: string | null;
    type: string | null;
    status: string | null;
    priority: number | null;
    position: number | null;
    description: string | null;
  }>;
  stories: Array<{
    id: string;
    epicId: string;
    title: string | null;
    acceptanceCriteria: string | null;
    position: number | null;
  }>;
  dependencies: Array<{ ticketId: string; dependsOnTicketId: string }>;
  /** Per-epic awaiting-reply inputs, keyed by epic id. */
  awaiting: Map<
    string,
    {
      latestSessionOutcome?: string | null;
      latestSessionEndedAt?: string | null;
      latestUserCommentCreatedAt?: string | null;
    }
  >;
  /** Latest agent comment per epic — surfaced only when awaiting a reply. */
  latestAgentComment: Map<string, string>;
}

function isPlanningStatus(status: string | null): status is RefinementStatus {
  return (REFINEMENT_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * Board reading order for one column: `position` ascending, with the ticket
 * id as the tiebreaker so two rows sharing a position never swap places
 * between two runs of the same snapshot.
 */
function byPosition(a: RefinementTicket, b: RefinementTicket): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function assembleRefinementSnapshot(
  input: RefinementSnapshotInput
): RefinementSnapshot {
  // Every epic in the project is needed to describe dependency endpoints,
  // even the ones outside the planning columns.
  const byId = new Map(input.epics.map((epic) => [epic.id, epic]));

  const describe = (ticketId: string): RefinementDependency => {
    const epic = byId.get(ticketId);
    const status = epic?.status ?? "unknown";
    return {
      ticketId,
      label: epic?.readableId ?? ticketId,
      status,
      // Shared with the board's blocked-state computation
      // (lib/kanban/queue.ts): "did this prerequisite ship?" must mean the
      // same thing in the snapshot the agent reads and on the card the user
      // sees, or the two quietly disagree about what is blocked.
      satisfied: isDeliveredStatus(status),
    };
  };

  const storiesByEpic = new Map<string, RefinementStory[]>();
  for (const story of [...input.stories].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0)
  )) {
    const criteria = story.acceptanceCriteria?.trim() ?? "";
    const list = storiesByEpic.get(story.epicId) ?? [];
    list.push({
      id: story.id,
      title: story.title ?? "(untitled story)",
      hasAcceptanceCriteria: criteria.length > 0,
      acceptanceCriteria: criteria.length > 0 ? criteria : null,
    });
    storiesByEpic.set(story.epicId, list);
  }

  const dependsOn = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  for (const edge of input.dependencies) {
    dependsOn.set(edge.ticketId, [
      ...(dependsOn.get(edge.ticketId) ?? []),
      edge.dependsOnTicketId,
    ]);
    blockedBy.set(edge.dependsOnTicketId, [
      ...(blockedBy.get(edge.dependsOnTicketId) ?? []),
      edge.ticketId,
    ]);
  }

  const tickets: RefinementTicket[] = [];
  for (const epic of input.epics) {
    if (!isPlanningStatus(epic.status)) continue;

    const awaiting = input.awaiting.get(epic.id);
    const isAwaiting = awaiting ? isAwaitingReply(awaiting) : false;

    tickets.push({
      id: epic.id,
      label: epic.readableId ?? epic.id,
      title: epic.title ?? "(untitled)",
      type: epic.type ?? "feature",
      status: epic.status,
      priority: epic.priority ?? 0,
      position: epic.position ?? 0,
      description: epic.description?.trim() || null,
      stories: storiesByEpic.get(epic.id) ?? [],
      dependsOn: (dependsOn.get(epic.id) ?? []).map(describe),
      // Only planning tickets are listed as blocked: work already in flight
      // is out of the re-pass's scope, so naming it would invite a move the
      // guardrail refuses.
      blocks: (blockedBy.get(epic.id) ?? [])
        .filter((id) => isPlanningStatus(byId.get(id)?.status ?? null))
        .map(describe),
      awaitingReply: isAwaiting,
      openQuestion: isAwaiting
        ? (input.latestAgentComment.get(epic.id) ?? null)
        : null,
    });
  }

  return {
    backlog: tickets.filter((t) => t.status === "backlog").sort(byPosition),
    todo: tickets.filter((t) => t.status === "todo").sort(byPosition),
  };
}

/** Total tickets a snapshot covers — the re-pass's workload. */
export function snapshotSize(snapshot: RefinementSnapshot): number {
  return snapshot.backlog.length + snapshot.todo.length;
}

/**
 * Read the project's planning columns and assemble the snapshot.
 *
 * The awaiting-reply inputs mirror the kanban query: the latest agent
 * session's delivery verdict against the latest user comment.
 */
export function loadRefinementSnapshot(projectId: string): RefinementSnapshot {
  const allEpics = db
    .select({
      id: epics.id,
      readableId: epics.readableId,
      title: epics.title,
      type: epics.type,
      status: epics.status,
      priority: epics.priority,
      position: epics.position,
      description: epics.description,
    })
    .from(epics)
    .where(eq(epics.projectId, projectId))
    .all();

  const planningIds = allEpics
    .filter((epic) => isPlanningStatus(epic.status))
    .map((epic) => epic.id);

  if (planningIds.length === 0) {
    return { backlog: [], todo: [] };
  }

  const stories = db
    .select({
      id: userStories.id,
      epicId: userStories.epicId,
      title: userStories.title,
      acceptanceCriteria: userStories.acceptanceCriteria,
      position: userStories.position,
    })
    .from(userStories)
    .where(inArray(userStories.epicId, planningIds))
    .all();

  // Edges are project-scoped; both endpoints matter, so keep any edge that
  // touches a planning ticket at either end.
  const dependencies = db
    .select({
      ticketId: ticketDependencies.ticketId,
      dependsOnTicketId: ticketDependencies.dependsOnTicketId,
    })
    .from(ticketDependencies)
    .where(
      and(
        eq(ticketDependencies.projectId, projectId),
        or(
          inArray(ticketDependencies.ticketId, planningIds),
          inArray(ticketDependencies.dependsOnTicketId, planningIds)
        )
      )
    )
    .all();

  const sessions = db
    .select({
      epicId: agentSessions.epicId,
      outcome: agentSessions.outcome,
      endedAt: agentSessions.endedAt,
      createdAt: agentSessions.createdAt,
    })
    .from(agentSessions)
    .where(inArray(agentSessions.epicId, planningIds))
    .all();

  const comments = db
    .select({
      epicId: ticketComments.epicId,
      author: ticketComments.author,
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
    })
    .from(ticketComments)
    .where(inArray(ticketComments.epicId, planningIds))
    .all();

  const latestSession = new Map<
    string,
    { outcome: string | null; endedAt: string | null; at: string }
  >();
  for (const session of sessions) {
    if (!session.epicId) continue;
    const at = session.endedAt ?? session.createdAt ?? "";
    const current = latestSession.get(session.epicId);
    if (!current || at >= current.at) {
      latestSession.set(session.epicId, {
        outcome: session.outcome ?? null,
        endedAt: session.endedAt ?? null,
        at,
      });
    }
  }

  const latestUserComment = new Map<string, string>();
  const latestAgentComment = new Map<string, string>();
  const latestAgentCommentAt = new Map<string, string>();
  for (const comment of comments) {
    if (!comment.epicId) continue;
    const at = comment.createdAt ?? "";
    if (comment.author === "user") {
      const current = latestUserComment.get(comment.epicId);
      if (!current || at >= current) latestUserComment.set(comment.epicId, at);
    } else {
      const current = latestAgentCommentAt.get(comment.epicId);
      if (!current || at >= current) {
        latestAgentCommentAt.set(comment.epicId, at);
        latestAgentComment.set(comment.epicId, comment.content);
      }
    }
  }

  const awaiting = new Map<
    string,
    {
      latestSessionOutcome?: string | null;
      latestSessionEndedAt?: string | null;
      latestUserCommentCreatedAt?: string | null;
    }
  >();
  for (const epicId of planningIds) {
    const session = latestSession.get(epicId);
    awaiting.set(epicId, {
      latestSessionOutcome: session?.outcome ?? null,
      latestSessionEndedAt: session?.endedAt ?? null,
      latestUserCommentCreatedAt: latestUserComment.get(epicId) ?? null,
    });
  }

  return assembleRefinementSnapshot({
    epics: allEpics,
    stories,
    dependencies,
    awaiting,
    latestAgentComment,
  });
}
