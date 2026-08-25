import {
  DISPATCH_RELIABILITY_MIN_SAMPLE,
  DISPATCH_RELIABILITY_WINDOW_DAYS,
  type DispatchReliabilityRow,
  type DispatchRole,
} from "./dispatch-reliability-constants";

/**
 * Informed agent selection for Full Auto Mode: pick the named agent with the
 * best measured success rate for a role instead of falling into the static
 * resolution chain.
 *
 * DELIBERATE LIMIT — this is a plain argmax over a 30-day window with a
 * minimum sample size. It is NOT a multi-armed bandit: there is no
 * exploration, no confidence interval, no decay, no per-project weighting. An
 * agent that has never run for a role never gets tried on purpose (it simply
 * stays below the threshold, so the normal default keeps dispatching it), and
 * an agent with an early lucky streak keeps its lead until enough later runs
 * move its average. That is the accepted trade: a rule a user can predict and
 * explain from the same numbers the picker badge shows beats a smarter
 * selector nobody can audit. If this ever needs exploration, it should become
 * an explicit strategy alongside this one, not a quiet change to this argmax.
 *
 * Two guards keep it inert by default:
 *   - it only runs when `auto_mode_smart_dispatch` is on (default OFF);
 *   - it only runs when the role has NO explicitly configured agent, so a
 *     user's own choice is never second-guessed.
 */

/** The chosen agent plus the numbers that chose it, for the activity trace. */
export interface SmartDispatchPick {
  namedAgentId: string;
  agentName: string | null;
  role: DispatchRole;
  successRate: number;
  sampleSize: number;
  medianDurationMs: number | null;
}

/**
 * Argmax of the success rate among rows that clear `minSample`.
 *
 * Ties are broken deterministically — larger sample first, then the lower
 * median duration, then agent name, then id — so the same board state always
 * produces the same dispatch. A random tiebreak would make an unattended mode
 * impossible to reproduce from its own log.
 */
export function pickBestByReliability(
  rows: DispatchReliabilityRow[],
  role: DispatchRole,
  minSample: number = DISPATCH_RELIABILITY_MIN_SAMPLE,
): SmartDispatchPick | null {
  const eligible = rows.filter(
    (row) =>
      row.role === role &&
      row.sampleSize >= minSample &&
      typeof row.successRate === "number",
  );
  if (eligible.length === 0) return null;

  const best = eligible.reduce((winner, row) =>
    compareReliability(row, winner) < 0 ? row : winner,
  );

  return {
    namedAgentId: best.namedAgentId,
    agentName: best.agentName,
    role,
    successRate: best.successRate as number,
    sampleSize: best.sampleSize,
    medianDurationMs: best.medianDurationMs,
  };
}

/** Negative when `a` should win over `b`. */
function compareReliability(
  a: DispatchReliabilityRow,
  b: DispatchReliabilityRow,
): number {
  const rateDelta = (b.successRate ?? 0) - (a.successRate ?? 0);
  if (rateDelta !== 0) return rateDelta;

  const sampleDelta = b.sampleSize - a.sampleSize;
  if (sampleDelta !== 0) return sampleDelta;

  // A null median sorts last: an agent whose runs never recorded a duration
  // should not beat one that demonstrably finishes fast.
  const aDuration = a.medianDurationMs ?? Number.POSITIVE_INFINITY;
  const bDuration = b.medianDurationMs ?? Number.POSITIVE_INFINITY;
  if (aDuration !== bDuration) return aDuration - bDuration;

  const nameDelta = (a.agentName ?? "").localeCompare(b.agentName ?? "");
  if (nameDelta !== 0) return nameDelta;

  return a.namedAgentId.localeCompare(b.namedAgentId);
}

export interface SmartDispatchQuery {
  role: DispatchRole;
  /** Scopes the sample to one project; omitted means all projects. */
  projectId?: string;
  minSample?: number;
  windowDays?: number;
  nowIso?: string;
}

/**
 * Reads the windowed reliability aggregate and returns the argmax for the
 * role, or null when nothing clears the sample threshold — in which case the
 * caller must keep its current default.
 *
 * The sample is deliberately NOT scoped to the calling project by default:
 * per-project histories are thin, and a threshold nothing ever clears would
 * make the setting a no-op that looks broken.
 */
export async function selectSmartDispatchAgent(
  query: SmartDispatchQuery,
): Promise<SmartDispatchPick | null> {
  // Imported lazily — same posture as review-segregation.ts — so the pure
  // argmax above stays importable (and testable) without instantiating the
  // database.
  const { getNamedAgentDispatchReliability } = await import("./stats");

  const rows = getNamedAgentDispatchReliability({
    ...(query.projectId ? { projectId: query.projectId } : {}),
    windowDays: query.windowDays ?? DISPATCH_RELIABILITY_WINDOW_DAYS,
    ...(query.nowIso ? { nowIso: query.nowIso } : {}),
  });

  return pickBestByReliability(
    rows,
    query.role,
    query.minSample ?? DISPATCH_RELIABILITY_MIN_SAMPLE,
  );
}
