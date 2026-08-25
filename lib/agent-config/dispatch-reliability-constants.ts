import { AGENT_TYPES, type AgentType } from "./constants";

/**
 * Client-safe vocabulary for the dispatch reliability badge — the window, the
 * sample threshold, the agent-type → role grouping and the badge formatter.
 *
 * Kept free of any database import so the agent pickers can render the badge
 * without pulling a server module into the bundle (same split as
 * lib/agent-config/review-segregation-constants.ts). The SQL aggregate lives
 * in lib/agent-config/stats.ts, the Full Auto argmax in
 * lib/agent-config/smart-dispatch.ts — both read their constants from here so
 * the badge a user sees and the choice the supervisor makes cannot drift
 * apart.
 */

/** How far back reliability is measured. Older sessions do not count. */
export const DISPATCH_RELIABILITY_WINDOW_DAYS = 30;

/**
 * Terminal runs a (named agent × role) pair needs inside the window before its
 * numbers are shown or acted on. Below it the badge renders an em-dash and the
 * Full Auto argmax refuses the pair: at two or three runs a "100% success"
 * reads as a recommendation while being pure noise.
 */
export const DISPATCH_RELIABILITY_MIN_SAMPLE = 5;

/**
 * The task types an agent gets picked for, as a user thinks about them. The
 * badge is per ROLE rather than per AgentType on purpose: a reviewer's record
 * is the same question whether the dispatch lands on `review_code` or
 * `review_security`, and a median cannot be recombined from per-type medians
 * afterwards — so the grouping has to happen inside the one SQL pass.
 */
export const DISPATCH_ROLES = [
  "build",
  "review",
  "merge",
  "qa",
  "chat",
  "spec",
  "release",
  "maintenance",
] as const;

export type DispatchRole = (typeof DISPATCH_ROLES)[number];

/** Every AgentType belongs to exactly one role — the partition is total. */
export const DISPATCH_ROLE_AGENT_TYPES: Record<DispatchRole, AgentType[]> = {
  build: ["build", "ticket_build", "team_build"],
  review: [
    "review_security",
    "review_code",
    "review_compliance",
    "review_feature",
  ],
  merge: ["merge"],
  qa: ["tech_check", "e2e_test"],
  chat: ["chat"],
  spec: ["spec_generation"],
  release: ["release_notes"],
  maintenance: ["memory_distill", "dreaming", "forensic"],
};

export const DISPATCH_ROLE_LABELS: Record<DispatchRole, string> = {
  build: "build",
  review: "review",
  merge: "merge",
  qa: "QA check",
  chat: "chat",
  spec: "spec generation",
  release: "release notes",
  maintenance: "maintenance",
};

/** Reverse index of DISPATCH_ROLE_AGENT_TYPES, built once at module load. */
export const AGENT_TYPE_TO_DISPATCH_ROLE: Record<AgentType, DispatchRole> =
  (() => {
    const map = {} as Record<AgentType, DispatchRole>;
    for (const role of DISPATCH_ROLES) {
      for (const agentType of DISPATCH_ROLE_AGENT_TYPES[role]) {
        map[agentType] = role;
      }
    }
    // A new AgentType with no role would silently vanish from every badge, so
    // fail loudly at import time instead of at 3am in an auto-mode sweep.
    const missing = AGENT_TYPES.filter((agentType) => !map[agentType]);
    if (missing.length > 0) {
      throw new Error(
        `DISPATCH_ROLE_AGENT_TYPES is missing: ${missing.join(", ")}`
      );
    }
    return map;
  })();

/** Role of an agent type, or null for an unknown/legacy value. */
export function dispatchRoleForAgentType(
  agentType: string | null | undefined
): DispatchRole | null {
  if (!agentType) return null;
  return AGENT_TYPE_TO_DISPATCH_ROLE[agentType as AgentType] ?? null;
}

/** One (named agent × role) aggregate over the reliability window. */
export interface DispatchReliabilityRow {
  namedAgentId: string;
  /** Name at dispatch time, falling back to the agent's current name. */
  agentName: string | null;
  role: DispatchRole;
  /** Terminal runs (completed + failed) inside the window. */
  sampleSize: number;
  completedCount: number;
  failedCount: number;
  /** completed / sampleSize; null when sampleSize is 0. */
  successRate: number | null;
  /** Median wall-clock duration of those runs (ms); null when unknown. */
  medianDurationMs: number | null;
}

export const RELIABILITY_EM_DASH = "—";

/** "4m 12s" / "38s" / "1h 05m", or an em-dash when the duration is unknown. */
export function formatReliabilityDuration(ms: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return RELIABILITY_EM_DASH;
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const mins = Math.floor(totalSeconds / 60);
  if (mins < 60) return `${mins}m ${totalSeconds % 60}s`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** "92%", or an em-dash when the rate is unknown. */
export function formatReliabilityPercent(ratio: number | null): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
    return RELIABILITY_EM_DASH;
  }
  return `${Math.round(ratio * 100)}%`;
}

/**
 * What the picker shows next to an agent's name for one role.
 *
 * Below the sample threshold — including "no row at all" — the label is a
 * single em-dash and the tooltip says how thin the sample is, because a
 * percentage computed from three runs would be read as evidence.
 */
export function formatReliabilityBadge(
  row: DispatchReliabilityRow | null | undefined,
  role: DispatchRole,
  minSample: number = DISPATCH_RELIABILITY_MIN_SAMPLE,
  windowDays: number = DISPATCH_RELIABILITY_WINDOW_DAYS
): { label: string; title: string; hasSample: boolean } {
  const roleLabel = DISPATCH_ROLE_LABELS[role];
  const sampleSize = row?.sampleSize ?? 0;

  if (sampleSize < minSample) {
    return {
      label: RELIABILITY_EM_DASH,
      title: `${sampleSize} ${roleLabel} run${sampleSize === 1 ? "" : "s"} in the last ${windowDays} days — under ${minSample}, too thin to score`,
      hasSample: false,
    };
  }

  const percent = formatReliabilityPercent(row?.successRate ?? null);
  const duration = formatReliabilityDuration(row?.medianDurationMs ?? null);
  return {
    label: `${percent} · ${duration}`,
    title: `${row?.completedCount ?? 0}/${sampleSize} ${roleLabel} runs succeeded in the last ${windowDays} days · median ${duration}`,
    hasSample: true,
  };
}
