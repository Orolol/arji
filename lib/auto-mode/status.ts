import type {
  AutoModeDispatchRecord,
  AutoModeParkedTicket,
} from "./registry";

/**
 * Frozen response shape of GET/PUT /api/projects/[projectId]/auto-mode.
 *
 * A type-only module (the imports above are erased at compile time), so the
 * dialog and the board toolbar can share the contract with the route without
 * dragging a server module into the client bundle — the same split
 * lib/night/constants.ts uses for the night-run response shapes.
 */
export interface AutoModeStatus {
  /** Persisted configuration (project key → global key → built-in default). */
  enabled: boolean;
  buildAgent: string | null;
  buildConcurrency: number;
  reviewAgent: string | null;
  reviewConcurrency: number;
  /**
   * Pick the build/review agent from its measured 30-day success rate when
   * the role has no explicit agent above. Off by default.
   */
  smartDispatch: boolean;
  /**
   * The scheduler's per-project `agent_max_concurrent` budget. Build + review
   * concurrency live ABOVE it: when their sum exceeds this the dialog warns
   * that the excess will queue. The mode never raises it silently.
   * `null` means unlimited (Infinity does not survive JSON serialization).
   */
  effectiveSchedulerBudget: number | null;
  /** True while the in-process supervisor is tracking this project. */
  running: boolean;
  lastSweepAt: string | null;
  /** Sessions of the mode's own dispatch that are still in flight. */
  inFlight: { build: number; review: number };
  /** What the next sweep would pick up right now. */
  candidates: { build: number; review: number; merge: number };
  parked: AutoModeParkedTicket[];
  recentDispatches: AutoModeDispatchRecord[];
}

export type { AutoModeDispatchRecord, AutoModeParkedTicket };
