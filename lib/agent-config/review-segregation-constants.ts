/**
 * Client-safe constants for the "Reviewer/grader must differ from builder"
 * feature. Server-side helpers live in ./review-segregation.ts (which
 * imports the db and must not be pulled into client bundles).
 */
export const REVIEW_PROVIDER_SEGREGATION_SETTING_KEY =
  "review_provider_segregation";
