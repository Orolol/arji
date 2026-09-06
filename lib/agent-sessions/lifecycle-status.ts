/**
 * The session lifecycle vocabulary, and NOTHING ELSE.
 *
 * WHY IT IS ITS OWN FILE. These three collections are the answer to "is this
 * session still going?", which is asked from the client as well as the server:
 * `lib/qa/aggregate.ts` needs it to tell a live QA check from a `qa_reports`
 * row stranded on `running`, and that module is pure by design and imported by
 * `components/qa/QaScreen.tsx`. `lifecycle.ts` — where these used to sit —
 * imports `@/lib/db`, so reading them from there pulled `better-sqlite3` into
 * the CLIENT bundle and `/qa` failed to compile with a `node:fs` module-not-
 * found. Neither `tsc` nor vitest can see that: both resolve the import
 * happily in Node, and only a real browser build fails.
 *
 * So: a leaf with no imports at all. `lifecycle.ts` re-exports it, so existing
 * server-side importers are unchanged and there is still one definition.
 */

export type AgentSessionLifecycleStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Every lifecycle status, as data.
 *
 * The `satisfies Record<…>` is not decoration: it makes TypeScript reject this
 * object if a member of the union is ever added and not listed, so the derived
 * sets below cannot silently misclassify a new status as non-terminal.
 */
export const SESSION_LIFECYCLE_STATUSES = Object.keys({
  queued: true,
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
} satisfies Record<AgentSessionLifecycleStatus, true>) as readonly AgentSessionLifecycleStatus[];

/**
 * The three statuses a session never leaves.
 *
 * `lib/qa/aggregate.ts` reads this to decide whether a `qa_reports` row that
 * still says `running` actually is — that column has ONE writer, at the tail of
 * a scheduler closure, so a restart, a rejected launch or a cancelled queue
 * entry strands it while the session row is reconciled correctly.
 *
 * `lib/workflow/review-freshness.ts` keeps its own SQL-string copy of the same
 * three words; it feeds the merge gate and is deliberately not rewired here.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Its complement — the statuses that still mean "going". Derived, never listed. */
export const NON_TERMINAL_STATUSES: readonly AgentSessionLifecycleStatus[] =
  SESSION_LIFECYCLE_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status));
