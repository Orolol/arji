/**
 * In-memory MCP token store — the auth backbone of the agent tool channel.
 *
 * Every injected agent session gets a bearer token minted at spawn time; the
 * /api/mcp/* routes resolve that token back to the session's identity
 * (session, project, epic, story, agent type). The token — never the request
 * body — is the authority for project scoping, which is what makes the MCP
 * surface safe against cross-project writes.
 *
 * Records are deliberately KEPT after revocation: the process-manager
 * completion handler revokes tokens before the dispatch routes classify the
 * session outcome, and the `askedQuestion` flag must survive until
 * `classifySessionOutcome` reads it via `wasQuestionAskedViaMcp`. Revocation
 * only invalidates authentication; the grace-period purge is the destructor.
 *
 * The purge is keyed on REVOCATION, never on mint time: a live (unrevoked)
 * record belongs to a process that is still running, and dropping it would
 * break the session's auth — and lose its `askedQuestion` flag — mid-run.
 * Long agent sessions routinely outlive any fixed mint-time TTL.
 *
 * globalThis-backed singleton (same pattern as
 * lib/agent-sessions/terminal-hooks.ts): dev hot reloads re-evaluate module
 * scope, and a module-local map would silently drop live tokens mid-session.
 */

import { createId } from "@/lib/utils/nanoid";

export interface McpTokenRecord {
  token: string;
  sessionId: string;
  projectId: string;
  epicId: string | null;
  userStoryId: string | null;
  agentType: string | null;
  /** Epoch ms at mint time. */
  createdAt: number;
  /** Epoch ms at revocation, or null while the token is live. */
  revokedAt: number | null;
  /** Set when the session called the ask_question MCP tool. */
  askedQuestion: boolean;
}

export interface MintMcpTokenContext {
  sessionId: string;
  projectId: string;
  epicId?: string | null;
  userStoryId?: string | null;
  agentType?: string | null;
}

/**
 * How long a REVOKED record is kept before `purgeExpiredMcpTokens` drops it.
 * Only has to outlive the gap between the process-manager revoking on exit
 * and the dispatch route reading `askedQuestion` during classification —
 * seconds in practice; an hour is generous headroom.
 */
export const REVOKED_TOKEN_GRACE_MS = 60 * 60 * 1000;

const STORE_GLOBAL_KEY = Symbol.for("arij.mcp-token-store");

type StoreGlobal = { [STORE_GLOBAL_KEY]?: Map<string, McpTokenRecord> };

function getStore(): Map<string, McpTokenRecord> {
  const holder = globalThis as StoreGlobal;
  holder[STORE_GLOBAL_KEY] ??= new Map<string, McpTokenRecord>();
  return holder[STORE_GLOBAL_KEY];
}

/**
 * Mint a new bearer token bound to a session's identity. Also purges expired
 * records so the store cannot grow without bound in a long-lived server.
 */
export function mintMcpToken(ctx: MintMcpTokenContext): string {
  purgeExpiredMcpTokens();
  const token = `arij-mcp-${createId()}${createId()}`;
  getStore().set(token, {
    token,
    sessionId: ctx.sessionId,
    projectId: ctx.projectId,
    epicId: ctx.epicId ?? null,
    userStoryId: ctx.userStoryId ?? null,
    agentType: ctx.agentType ?? null,
    createdAt: Date.now(),
    revokedAt: null,
    askedQuestion: false,
  });
  return token;
}

/**
 * Resolve a bearer token to its record. Returns null for unknown tokens AND
 * for revoked ones — routes treat both as 401.
 */
export function resolveMcpToken(token: string): McpTokenRecord | null {
  const record = getStore().get(token);
  if (!record || record.revokedAt !== null) return null;
  return record;
}

/**
 * Resolve a bearer token to its record REGARDLESS of revocation — the lookup
 * for callers that have already been refused and only want to know WHO was
 * refused. Never use it to authenticate: `resolveMcpToken` is the only
 * function that may gate a write.
 *
 * Its one caller is the submit_findings 401 trace
 * (lib/mcp/review-channel-failure.ts): a reviewer whose token was revoked
 * mid-call is still a known session, and attributing the rejection to it is
 * the difference between "a review filed nothing" and "a review was stopped
 * from filing".
 */
export function findMcpTokenRecord(token: string): McpTokenRecord | null {
  return getStore().get(token) ?? null;
}

/**
 * Invalidate every live token minted for a session (called when the session
 * process exits or is cancelled). Keeps the records — see module header for
 * why deletion here would lose the askedQuestion flag before classification.
 */
export function revokeMcpTokensForSession(sessionId: string): void {
  const now = Date.now();
  for (const record of getStore().values()) {
    if (record.sessionId === sessionId && record.revokedAt === null) {
      record.revokedAt = now;
    }
  }
}

/**
 * Record that the session asked the user a question via the ask_question
 * tool. Returns true when at least one record for the session existed.
 */
export function markQuestionAsked(sessionId: string): boolean {
  let found = false;
  for (const record of getStore().values()) {
    if (record.sessionId === sessionId) {
      record.askedQuestion = true;
      found = true;
    }
  }
  return found;
}

/**
 * Whether the session asked a question through the MCP channel. Reads the
 * flag even from revoked records — outcome classification runs after the
 * completion handler has already revoked the session's tokens.
 */
export function wasQuestionAskedViaMcp(sessionId: string): boolean {
  for (const record of getStore().values()) {
    if (record.sessionId === sessionId && record.askedQuestion) return true;
  }
  return false;
}

/**
 * Drop records that were revoked more than `REVOKED_TOKEN_GRACE_MS` ago.
 * Returns the number of records removed. Called on every mint; callable
 * directly for tests.
 *
 * LIVE (unrevoked) records are NEVER purged, however old they are — their
 * session is by definition still running, and dropping the record would
 * 401 the agent's tool calls and erase its `askedQuestion` flag mid-run.
 */
export function purgeExpiredMcpTokens(now: number = Date.now()): number {
  const store = getStore();
  let dropped = 0;
  for (const [token, record] of store) {
    if (record.revokedAt === null) continue;
    if (now - record.revokedAt > REVOKED_TOKEN_GRACE_MS) {
      store.delete(token);
      dropped++;
    }
  }
  return dropped;
}

/** Test-only: empty the store so cases cannot leak tokens into each other. */
export function _resetMcpTokenStoreForTests(): void {
  getStore().clear();
}
