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
