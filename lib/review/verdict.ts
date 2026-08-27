/**
 * The structured review verdict vocabulary, verbatim.
 *
 * The enum itself lives in the `submit_findings` tool schema
 * (app/api/mcp/submit-findings/route.ts and bin/arij-mcp.mjs); this is the
 * shared reading of it. Sibling of lib/review/finding-severity.ts and
 * client-safe for the same reason: the board, the pipeline and the workflow
 * engine all have to agree on what a reviewer said, and `lib/workflow/*`
 * must not reach into `lib/pipeline/*` to find out.
 */

export const STRUCTURED_REVIEW_VERDICTS = [
  "approved",
  "approved_with_minor_issues",
  "changes_requested",
] as const;

export type StructuredReviewVerdict =
  (typeof STRUCTURED_REVIEW_VERDICTS)[number];

/** The only verdict that blocks on its own. */
export const NEGATIVE_STRUCTURED_VERDICT: StructuredReviewVerdict =
  "changes_requested";

/**
 * The column is free text, so an unrecognised value is treated as absent
 * rather than trusted — a verdict the decision table has no rule for must
 * not silently pass as an approval.
 */
export function isStructuredReviewVerdict(
  value: string | null | undefined
): value is StructuredReviewVerdict {
  return (
    typeof value === "string" &&
    (STRUCTURED_REVIEW_VERDICTS as readonly string[]).includes(value)
  );
}
