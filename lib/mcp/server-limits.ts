/**
 * Caps, the secret mask, and the read-side view type for MCP servers.
 *
 * Split out of lib/mcp/servers.ts so CLIENT components can import them: that
 * module reaches `@/lib/db` and `child_process` (through user-global-sync), and
 * pulling either into the browser bundle is a build failure at best and a
 * server-code leak at worst. Everything here is a plain constant or a type.
 *
 * The caps live in ONE place on purpose. The service rejects over-length input
 * explicitly rather than truncating it, and the form mirrors the same numbers
 * as `maxLength` — two halves of one rule. A second copy in the UI is how they
 * drift, and a drifted cap means a form that accepts what the API refuses.
 */

export const MCP_SERVER_NAME_MAX_LENGTH = 64;
export const MCP_SERVER_COMMAND_MAX_LENGTH = 512;
export const MCP_SERVER_URL_MAX_LENGTH = 2048;
export const MCP_SERVER_USAGE_HINT_MAX_LENGTH = 200;
export const MCP_SERVER_ARG_MAX_LENGTH = 512;
export const MCP_SERVER_ARGS_MAX_ITEMS = 32;
export const MCP_SERVER_ARGS_MAX_TOTAL_LENGTH = 4096;
export const MCP_SERVER_ENV_MAX_KEYS = 16;
export const MCP_SERVER_ENV_KEY_MAX_LENGTH = 128;
export const MCP_SERVER_ENV_VALUE_MAX_LENGTH = 4096;
export const MCP_SERVER_HEADERS_MAX_KEYS = 16;
export const MCP_SERVER_HEADERS_KEY_MAX_LENGTH = 128;
export const MCP_SERVER_HEADERS_VALUE_MAX_LENGTH = 4096;
export const MCP_SERVER_AGENT_TYPES_MAX_ITEMS = 32;
export const MCP_SERVER_AGENT_TYPE_MAX_LENGTH = 128;
export const MCP_SERVER_TOOL_ALLOWLIST_MAX_ITEMS = 32;
export const MCP_SERVER_TOOL_NAME_MAX_LENGTH = 128;

/**
 * Value the API returns instead of a stored secret. The UI treats it as "not
 * shown", never as a value to send back — see McpServersSection.
 */
export const MCP_SERVER_SECRET_MASK = "***";

export type McpServerTransport = "stdio" | "http";

/** A server as the API returns it: every secret VALUE replaced by the mask. */
export interface McpServerView {
  id: string;
  /** NULL (null in JSON) = global server. */
  projectId: string | null;
  name: string;
  enabled: boolean;
  transport: McpServerTransport;
  command: string | null;
  args: string[];
  /** WRITE-ONLY: every value is MCP_SERVER_SECRET_MASK. Keys are real. */
  env: Record<string, string>;
  url: string | null;
  /** WRITE-ONLY: every value is MCP_SERVER_SECRET_MASK. Keys are real. */
  headers: Record<string, string>;
  /** NULL = applies to every agent type and chat turns. */
  agentTypes: string[] | null;
  /** NULL = every tool the server exposes. */
  toolAllowlist: string[] | null;
  usageHint: string | null;
  lastCheckedAt: string | null;
  /** NULL = never checked. */
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  createdAt: string;
}
