/** Shared constants for the agent-scoped `create_bug` MCP action. */

/** A deliberately small ceiling: this is an escape hatch, not a ticket generator. */
export const MAX_MCP_BUGS_PER_SESSION = 5;

/**
 * Durable activity marker used both for rate-limit accounting and the
 * session's "Arij actions" read model. Keep it stable once released.
 */
export const MCP_CREATE_BUG_ACTIVITY_PREFIX = "Agent MCP create_bug:";

export const MCP_CREATE_BUG_ACTION_HEADER = "x-arij-mcp-action";
export const MCP_CREATE_BUG_SOURCE_TICKET_HEADER =
  "x-arij-mcp-source-ticket-id";

export function isMcpCreateBugActivityReason(
  reason: string | null | undefined,
): boolean {
  return reason?.startsWith(MCP_CREATE_BUG_ACTIVITY_PREFIX) ?? false;
}

export function buildMcpCreateBugActivityReason(input: {
  sourceTicketRef: string;
  sourceStoryId?: string | null;
  sessionId: string;
}): string {
  const storyRef = input.sourceStoryId
    ? `; source story ${input.sourceStoryId}`
    : "";
  return `${MCP_CREATE_BUG_ACTIVITY_PREFIX} reported from ${input.sourceTicketRef}${storyRef}; source session ${input.sessionId}`;
}

export const MCP_BUG_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type McpBugSeverity = (typeof MCP_BUG_SEVERITIES)[number];
