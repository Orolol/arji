/**
 * The one way to order agent sessions in time.
 *
 * Session timestamps mix two formats in the same column: ISO-8601
 * (`2026-08-16T09:00:00.000Z`, what routes write) and SQLite
 * CURRENT_TIMESTAMP (`2026-08-16 09:00:00`, what a defaulted column stores).
 * They are compared lexicographically by MAX/ORDER BY, and ' ' sorts before
 * 'T' — so an unnormalised comparison ranks EVERY space-form row below EVERY
 * ISO row of the same day. "The latest session" then silently resolves to the
 * wrong one.
 *
 * `REPLACE(…, ' ', 'T')` makes the lexicographic order chronological. This
 * module exists so that expression has a single home: it had been copied into
 * lib/auto-mode/select.ts and lib/auto-mode/second-opinion.ts, and the third
 * copy is the one that forgets the REPLACE.
 *
 * `normalizeAt` is the JS-side twin, for comparing values already in hand —
 * the same normalisation lib/kanban/awaiting-reply.ts does.
 *
 * The SQL side is a FUNCTION, not a module-level constant, on purpose: a
 * `sql` template at module scope is evaluated on import, and this module is
 * pulled in (via lib/pipeline/findings.ts → lib/workflow/context.ts) by most
 * of the workflow layer. That would make every test partially mocking
 * `drizzle-orm` anywhere in the chain fail at import time on a missing `sql`
 * export — a coupling that has nothing to do with what those tests assert.
 */

import { sql } from "drizzle-orm";
import { agentSessions } from "@/lib/db/schema";

/**
 * When a session reached its terminal state, normalised for lexicographic
 * comparison. Falls back through endedAt → completedAt → createdAt, so a row
 * that never recorded an end is still orderable by when it was created.
 */
export function sessionAtSql() {
  return sql`REPLACE(COALESCE(${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.createdAt}), ' ', 'T')`;
}

/** JS-side twin of {@link sessionAtSql}, for values already read. */
export function normalizeAt(value: string): string {
  return value.includes("T") ? value : value.replace(" ", "T");
}
