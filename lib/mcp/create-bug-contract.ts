/** Shared constants for the agent-scoped `create_bug` MCP action. */

/** A deliberately small ceiling: this is an escape hatch, not a ticket generator. */
export const MAX_MCP_BUGS_PER_SESSION = 5;

/**
 * Durable activity marker used both for rate-limit accounting and the
 * session's "Arij actions" read model. Keep it stable once released.
 */
export const MCP_CREATE_BUG_ACTIVITY_PREFIX = "Agent MCP create_bug:";

export const MCP_BUG_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type McpBugSeverity = (typeof MCP_BUG_SEVERITIES)[number];
