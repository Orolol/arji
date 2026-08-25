export const FRICTION_CATEGORIES = [
  "broken_tooling",
  "misleading_docs",
  "flaky_test",
  "unclear_convention",
  "other",
] as const;

export type FrictionCategory = (typeof FRICTION_CATEGORIES)[number];

export const FRICTION_STATUSES = [
  "new",
  "triaged",
  "converted",
  "dismissed",
] as const;

export type FrictionStatus = (typeof FRICTION_STATUSES)[number];

/** Only unresolved rows participate in soft deduplication. */
export const OPEN_FRICTION_STATUSES = ["new", "triaged"] as const;
