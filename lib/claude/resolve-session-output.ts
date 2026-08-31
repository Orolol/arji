import {
  parseClaudeOutput,
  isNoTextualOutputFallback,
  extractUsageFromOutput,
} from "./json-parser";
import type { ClaudeResult } from "./spawn";
import type {
  SessionOutcome,
  SessionUsage,
} from "@/lib/agent-sessions/lifecycle";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { wasQuestionAskedViaMcp } from "@/lib/mcp/token-store";

/**
 * Resolves the best available text output for a completed agent session.
 *
 * The resolution order is:
 * 1. Parse `result.result` via `parseClaudeOutput()` — works when the agent
 *    produced a final text message.
 * 2. For a FAILED run with no final text, stop at `result.error`: the
 *    streamed `lastNonEmptyText` of a run that died mid-task is whatever the
 *    model said last before dying — pre-tool-call narration ("Now let me
 *    look at…"), not a deliverable. Posted to a ticket it reads as leaked
 *    thinking, and the comment history then feeds it back into every later
 *    prompt (measured 2026-08-27 on E-arij-138).
 * 3. Otherwise (success, or no result envelope at all), look up
 *    `lastNonEmptyText` from the `agent_sessions` table — this field is
 *    populated by streaming chunks (non-CC providers) or by the process
 *    manager's result-chunk persistence (CC provider).
 * 4. Fall back to `result.error` or a generic default message.
 */
export function resolveSessionOutput(
  result: ClaudeResult | undefined | null,
  sessionId: string,
  defaultMessage = "Agent session completed without output.",
): string {
  // Try parsing the raw CLI output
  if (result?.result) {
    const raw = parseClaudeOutput(result.result).content;
    if (raw && !isNoTextualOutputFallback(raw)) {
      const parsed = stripPromptEcho(raw, sessionId);
      if (parsed) return parsed;
    }
  }

  // A failed run with no final text delivered nothing — report the failure,
  // not the mid-stream narration (see the resolution-order contract above).
  if (result && !result.success) {
    return result.error || defaultMessage;
  }

  // Try lastNonEmptyText from DB
  const lastText = stripPromptEcho(getLastNonEmptyText(sessionId), sessionId);
  if (lastText) {
    return lastText;
  }

  // Fall back to error or default
  return result?.error || defaultMessage;
}

/**
 * Prompts below this length are not worth echo-scrubbing: the exact-substring
 * check could only fire on legitimately quoted short text.
 */
const PROMPT_ECHO_MIN_CHARS = 500;

/** Replaces a stripped echo. Kept short — it can appear in ticket comments. */
export const PROMPT_ECHO_MARKER =
  "_[Arij: the session's raw output echoed its own prompt — echo removed.]_";

/**
 * Removes verbatim copies of the session's OWN prompt from its output.
 *
 * Some CLI failure modes (measured: omp exiting unauthenticated) echo the
 * prompt to stdout, sometimes more than once. Left alone, that echo became a
 * ticket comment, the next prompt embedded the comment history, the next
 * failure echoed THAT — the geometric snowball that produced a 4.9 MB review
 * prompt holding 81 nested copies of the project spec (2026-08-26). No
 * consumer of a session's output ever wants the prompt back, so the scrub
 * lives here, in the single choke point every dispatch path resolves
 * output through.
 *
 * Exact-substring only: `agent_sessions.prompt` is the byte-exact string the
 * CLI was spawned with, and the measured echoes were exact copies. Partial
 * echoes are caught by the prompt-side per-comment budget
 * (commentHistorySection in prompt-builder.ts).
 */
function stripPromptEcho(
  output: string | null,
  sessionId: string,
): string | null {
  if (!output) return output;
  const prompt = getSessionPrompt(sessionId);
  if (!prompt || prompt.length < PROMPT_ECHO_MIN_CHARS) return output;
  if (!output.includes(prompt)) return output;

  const stripped = output
    .split(prompt)
    .join(PROMPT_ECHO_MARKER)
    // An n-times echo (the measured case was exactly twice) collapses to one
    // marker instead of a marker per copy.
    .replaceAll(
      `${PROMPT_ECHO_MARKER}\n\n${PROMPT_ECHO_MARKER}`,
      PROMPT_ECHO_MARKER,
    )
    .replaceAll(`${PROMPT_ECHO_MARKER}${PROMPT_ECHO_MARKER}`, PROMPT_ECHO_MARKER)
    .trim();

  // Nothing but the echo: report that as "no output", not as content.
  return stripped === PROMPT_ECHO_MARKER ? null : stripped;
}


/**
 * Deterministically classifies a finished agent run into its delivery verdict.
 *
 * This is the single choke point every dispatch route threads through
 * `markSessionTerminal` so the outcome is persisted for ALL agent paths:
 *
 *   - error:          the run failed (missing result counts as failure)
 *   - asked_question: the agent ended by asking the user a question. Two
 *                     signals feed this, in precedence order:
 *                       1. the MCP `ask_question` tool call — an authoritative,
 *                          structured signal recorded on the session's token
 *                          record (`wasQuestionAskedViaMcp`), and
 *                       2. the prose heuristic (`endedWithQuestion`, detected
 *                          by the providers via `hasAskUserQuestion` over
 *                          their output streams) — the fallback for sessions
 *                          without MCP injection.
 *   - answered:       the run produced a textual deliverable, either in the
 *                     final result envelope or streamed via `lastNonEmptyText`
 *   - silent:         success, but no textual deliverable anywhere
 *                     (the NO_TEXTUAL_OUTPUT_FALLBACK-style empty case)
 *
 * The text checks mirror `resolveSessionOutput`'s resolution order so the
 * verdict never disagrees with the output shown to the user.
 */
export function classifySessionOutcome(
  result: ClaudeResult | undefined | null,
  sessionId: string,
): SessionOutcome {
  if (!result?.success) {
    return "error";
  }

  // Authoritative structured signal: the agent called the MCP
  // `mcp__arij__ask_question` tool during this run. Checked after the error
  // branch (a failed run stays "error" even if it asked first) and before
  // the prose heuristic (the tool call is verifiable; text detection is a
  // guess). In-memory storage is sufficient — classification always happens
  // in-process before markSessionTerminal, and revocation keeps the record.
  if (wasQuestionAskedViaMcp(sessionId)) {
    return "asked_question";
  }

  if (result.endedWithQuestion) {
    return "asked_question";
  }

  // Mirror resolveSessionOutput's echo scrub: a run whose only "output" is a
  // copy of its own prompt delivered nothing.
  if (result.result) {
    const raw = parseClaudeOutput(result.result).content;
    if (
      raw &&
      !isNoTextualOutputFallback(raw) &&
      stripPromptEcho(raw, sessionId)
    ) {
      return "answered";
    }
  }

  if (stripPromptEcho(getLastNonEmptyText(sessionId), sessionId)) {
    return "answered";
  }

  return "silent";
}

/**
 * Extracts the token/cost usage a finished run reported, for persistence via
 * `markSessionTerminal`'s optional `usage` field (same choke points as the
 * delivery verdict above).
 *
 * Only the Claude Code provider retains its raw result envelope (with
 * `usage` and `total_cost_usd`) in `result.result` — the other providers
 * extract plain text, so this returns `undefined` for them and their usage
 * columns stay NULL. Works for failed runs too: the spawn keeps the raw
 * stdout in `result.result` on non-zero exits, so the cost of failed runs
 * is still accounted for when the envelope made it out.
 */
export function extractSessionUsage(
  result: ClaudeResult | undefined | null,
): SessionUsage | undefined {
  if (!result?.result) return undefined;
  const usage = extractUsageFromOutput(result.result);
  return usage ?? undefined;
}

function getSessionPrompt(sessionId: string): string | null {
  try {
    const row = db
      .select({ prompt: agentSessions.prompt })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    return row?.prompt ?? null;
  } catch {
    return null;
  }
}

function getLastNonEmptyText(sessionId: string): string | null {
  try {
    const row = db
      .select({ lastNonEmptyText: agentSessions.lastNonEmptyText })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    return row?.lastNonEmptyText ?? null;
  } catch {
    return null;
  }
}
