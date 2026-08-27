/**
 * The severity vocabulary a review finding carries, and which of it blocks.
 *
 * `submit_findings` files each finding as a `review_comments` row whose body
 * is prefixed `[<severity>] ` with the vocabulary critical|major|minor|info
 * (app/api/mcp/submit-findings/route.ts). `[critical]` and `[major]` mean
 * "this must be fixed before the work lands"; `[minor]` and `[info]` are the
 * reviewer's own word for "not blocking" — the same distinction the
 * `approved_with_minor_issues` verdict makes.
 *
 * Client-safe: pure string predicates, no database, no server imports. The
 * board needs the same vocabulary the pipeline uses, and a second copy of
 * these prefixes is how a card would start disagreeing with the gate.
 */

/**
 * The complete vocabulary, most severe first. Both writers of an
 * agent-authored row normalise to exactly these four before prefixing
 * (`submit_findings`' zod enum, and `normalizeSeverity` in
 * lib/pipeline/parse-review-report.ts), so a body outside this list is a row
 * no reviewer classified.
 */
export const FINDING_SEVERITY_PREFIXES = [
  { prefix: "[critical]", severity: "critical", blocking: true },
  { prefix: "[major]", severity: "major", blocking: true },
  { prefix: "[minor]", severity: "minor", blocking: false },
  { prefix: "[info]", severity: "info", blocking: false },
] as const;

/** Body prefixes (as written by submit_findings) that block. */
export const BLOCKING_FINDING_PREFIXES = FINDING_SEVERITY_PREFIXES.filter(
  (entry) => entry.blocking
);

export type FindingSeverityLabel =
  (typeof FINDING_SEVERITY_PREFIXES)[number]["severity"];

export type BlockingFindingSeverity = Extract<
  FindingSeverityLabel,
  "critical" | "major"
>;

/**
 * The blocking severity a body declares, or null when it declares none.
 *
 * Exact prefix match, deliberately: an agent finding that carries NO
 * recognised prefix is not silently downgraded to "informational" — callers
 * that need a decision for such a row make it themselves (the merge gate
 * treats it as blocking, because an unclassified concern is not a cleared
 * one).
 */
export function blockingFindingSeverity(
  body: string | null | undefined
): BlockingFindingSeverity | null {
  if (typeof body !== "string") return null;
  const match = BLOCKING_FINDING_PREFIXES.find(({ prefix }) =>
    body.startsWith(prefix)
  );
  return match ? match.severity : null;
}
