/**
 * In-process record of what a refinement session changed.
 *
 * The end-of-run report needs to say "4 promoted, 2 sent back, 3 edges
 * added". It could scrape that out of `ticket_activity_log`'s reason strings,
 * but prose parsing is exactly the fragility structured channels exist to
 * avoid: the reason text is written for a human, and a wording change would
 * silently start producing empty reports. So each refinement tool appends a
 * typed record here as it succeeds, and the report reads those.
 *
 * The activity log stays the durable per-ticket audit trail — that is its
 * job. This registry is only the run-scoped aggregation, and it is
 * deliberately in-process: a refinement session does not survive a server
 * restart either (its process is gone and the session row is failed), so
 * there is no report to rebuild after one.
 *
 * globalThis-backed for the same reason as the MCP token store: dev hot
 * reloads re-evaluate module scope, and a module-local map would drop the
 * records of a session that is still running.
 */

import { REFINEMENT_AGENT_TYPE } from "./constants";

export type RefinementChangeKind =
  | "promoted"
  | "demoted"
  | "priority"
  | "reordered"
  | "dependency_added"
  | "dependency_removed"
  | "merged"
  | "discarded"
  | "created";

export interface RefinementChange {
  kind: RefinementChangeKind;
  /** The ticket the change was applied to. */
  ticketId: string;
  /** Readable id when the ticket has one, else the raw id. */
  label: string;
  /** Short human phrase describing the change ("priority 1 → 3"). */
  detail: string;
  /** The agent's mandatory justification, verbatim. */
  reason: string;
  /**
   * True when `ticketId` names a row that no longer exists — a discarded
   * ticket. The report must not link to it and must not try to post its
   * recap comment on it.
   *
   * A `merged` record deliberately does NOT set this: it is filed against
   * the surviving TARGET, which is also where the sources' tombstones were
   * already posted.
   */
  ticketGone?: boolean;
  /**
   * The full text of what left the board, for the kinds that destroy a
   * ticket. Rendered into the end-of-run recap comment, which for a discard
   * is the only durable copy left.
   */
  snapshot?: string;
}

/**
 * Per-session cap. A re-pass over a normal board writes tens of records;
 * this only exists so a runaway loop cannot grow the map without bound.
 */
export const MAX_RECORDED_CHANGES = 2000;

const REGISTRY_GLOBAL_KEY = Symbol.for("arij.refinement-change-registry");

type RegistryGlobal = {
  [REGISTRY_GLOBAL_KEY]?: Map<string, RefinementChange[]>;
};

function getRegistry(): Map<string, RefinementChange[]> {
  const holder = globalThis as RegistryGlobal;
  holder[REGISTRY_GLOBAL_KEY] ??= new Map<string, RefinementChange[]>();
  return holder[REGISTRY_GLOBAL_KEY];
}

/**
 * Append a change made by a refinement session.
 *
 * A no-op for every other agent type: the board tools are available to any
 * non-chat session, but only a refinement run produces a report, and
 * recording for sessions that never drain would leak entries.
 */
export function recordRefinementChange(
  auth: { sessionId: string; agentType: string | null },
  change: RefinementChange
): void {
  if (auth.agentType !== REFINEMENT_AGENT_TYPE) return;
  const registry = getRegistry();
  const changes = registry.get(auth.sessionId) ?? [];
  if (changes.length >= MAX_RECORDED_CHANGES) return;
  changes.push(change);
  registry.set(auth.sessionId, changes);
}

/** Read a session's changes without consuming them. */
export function peekRefinementChanges(sessionId: string): RefinementChange[] {
  return [...(getRegistry().get(sessionId) ?? [])];
}

/**
 * Read and drop a session's changes. Called once, when the session settles
 * and its report is built — draining is what keeps the map bounded.
 */
export function takeRefinementChanges(sessionId: string): RefinementChange[] {
  const changes = peekRefinementChanges(sessionId);
  getRegistry().delete(sessionId);
  return changes;
}

/** Test seam. */
export function _resetRefinementRegistryForTests(): void {
  getRegistry().clear();
}
