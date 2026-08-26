/**
 * Per-provider session-continuity capabilities.
 *
 * These two questions look alike but are not the same, and every dispatch
 * route needs both. Keeping them here — with no `db` import, so client code
 * can use them too — is what stops the answers drifting apart across the
 * build, review, merge and session-picker routes.
 */

import type { ProviderType } from "@/lib/providers/types";

/**
 * Providers whose CLI can continue a previous session.
 *
 * - claude-code: --resume <ID>
 * - oh-my-pi: --resume <ID> (standalone `omp` fork of pi; no --session flag)
 * - agy: --conversation <ID> (verified on 1.1.21: the resumed turn recalls
 *   first-turn context and echoes the same conversation_id)
 *
 * Codex is excluded even though `codex exec resume <ID>` exists and
 * `fix(codex): enable session resume` (b3d25eb, Feb 2026) wired it into the
 * routes: codex never reports the thread id it created (see
 * `CodexProvider.parseSessionId`), so the only id Arij can store is one it
 * invented. `feat: autonomous build -> review -> fix pipeline` (a6568b2, Aug
 * 2026) settled it — "the build routes' local list ... wrongly includes
 * codex". This list is that verdict, in one place.
 */
const RESUMABLE_PROVIDERS = new Set<ProviderType>([
  "claude-code",
  "oh-my-pi",
  "agy",
]);

/**
 * Providers that announce the session id they created, so dispatch must NOT
 * invent one for them: omp prints pi's `{"type":"session","id":…}` header
 * and `PiProvider.parseSessionId` reads it back; agy's JSON envelope
 * carries `conversation_id`. A pre-assigned id would be stored, never used
 * by the CLI, and then replayed into the resume flag on a later run.
 */
const SELF_REPORTED_SESSION_ID_PROVIDERS = new Set<ProviderType>([
  "oh-my-pi",
  "agy",
]);

/**
 * Providers the dispatch routes pre-assign a session id for
 * (`crypto.randomUUID()`, recorded before the agent starts). Claude Code
 * consumes it via `--session-id`; codex is kept because its stored id has
 * always come from this pre-assignment.
 */
const ASSIGNED_SESSION_ID_PROVIDERS = new Set<ProviderType>([
  "claude-code",
  "codex",
]);

/** True when a completed session of this provider can be resumed. */
export function isResumableProvider(provider: ProviderType | string): boolean {
  return RESUMABLE_PROVIDERS.has(provider as ProviderType);
}

/** True when the provider reports its own session id in its output. */
export function providerReportsOwnSessionId(
  provider: ProviderType | string,
): boolean {
  return SELF_REPORTED_SESSION_ID_PROVIDERS.has(provider as ProviderType);
}

/** True when a dispatch route should pre-assign a session id. */
export function providerAcceptsAssignedSessionId(
  provider: ProviderType | string,
): boolean {
  return ASSIGNED_SESSION_ID_PROVIDERS.has(provider as ProviderType);
}
