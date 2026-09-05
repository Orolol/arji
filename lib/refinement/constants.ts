/**
 * Constants shared by the board-refinement re-pass.
 *
 * Kept in their own module because the agent type is read from both server
 * modules (dispatch, snapshot, report) and route handlers that must not pull
 * in the dispatch module's process-manager dependency graph.
 */

/** Session agent type for a board refinement re-pass. */
export const REFINEMENT_AGENT_TYPE = "refinement" as const;

/** Human label used in notifications and the session monitor. */
export const REFINEMENT_LABEL = "Board Refinement";

/**
 * Sources one `merge_tickets` call may absorb.
 *
 * A merge is a judgement about a small cluster of near-duplicates; a call
 * naming twenty tickets is a runaway, not a merge, and every one of them is a
 * permanent delete.
 */
export const MAX_MERGE_SOURCES = 8;

/**
 * Tickets one refinement pass may add with `create_planning_ticket`.
 *
 * A re-pass that notices a dozen gaps has stopped refining and started
 * planning a project from scratch — which is the epic creation flow's job,
 * with a human in it.
 */
export const MAX_REFINEMENT_CREATED_TICKETS = 10;
