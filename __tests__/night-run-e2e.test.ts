/**
 * End-to-end tests for NIGHT RUNS: the REAL batch build route (dag +
 * pipeline), the night engine (lib/night/run.ts), the wave engine, the REAL
 * autonomous pipeline (startPipelineRun + runner + stage drivers + findings
 * + forensic), the scheduler, session lifecycle, and the night summary /
 * GET routes — all against a fully-migrated createTestDb.
 *
 * This is the cross-builder seam proof: the route-level suite mocks
 * startNightRun and the engine suite mocks startPipelineRun, so neither
 * exercises the actual composition (route launcher → night adapter → real
 * pipeline terminal → wave settlement → morning summary). Here the ONLY
 * fake is the CLI itself: the process manager serves scripted per-session
 * results matched by (mode, cwd, prompt shape) — the pipeline-e2e
 * pattern, made order-independent because night waves run several epics
 * (and their stage sessions) concurrently.
 *
 * Scenarios:
 *   (a) 5-epic diamond (a → b,c → d → e), every pipeline clean → waves run
 *       in dependency order gated at PIPELINE terminal (a's review precedes
 *       b/c's builds), every epic parks in Review, counts right, exactly one
 *       summary notification + one night_run.completed webhook, every
 *       session row tagged batch_run_id, GET list/detail serve the run;
 *   (b) one epic's pipeline fails → its transitive dependents are skipped,
 *       independent branches finish, forensic ran, and the breaker at the
 *       default threshold 3 does NOT trip;
 *   (c) three consecutive pipeline failures → the circuit breaker trips at
 *       the wave boundary: in-flight epics settle normally, the remaining
 *       wave is skipped with the breaker reason verbatim, and the summary
 *       says so;
 *   (d) a review asks a question → pipeline paused_question → the wave
 *       counts it "asked"/"paused", the ticket is HELD in review, dependents
 *       skip, independent epics keep building (halt policy) and the run
 *       completes;
 *   (e) cost cap: Claude-reported envelope costs flow through
 *       extractSessionUsage → agent_sessions.total_cost_usd → SUM at the
 *       wave boundary; crossing the cap aborts the remaining waves;
 *   (f) interrupted-run derivation: registry empty (server restarted),
 *       sessions tagged in the DB → the GET routes rebuild the morning
 *       story with interrupted: true;
 *   (g) user stop: POST .../stop mid-wave → the in-flight pipeline finishes
 *       (never force-cancelled), the remaining epics are skipped "stopped by
 *       user", and the summary uses the stopped variant.
 *
 * Client/server wording seam: the summary-notification titles are asserted
 * against the UI's client-side formatters (components/night/night-run-format)
 * so the deliberate copy of the wording cannot drift silently.
 *
 * TIMING: fake timers (pipeline-e2e pattern) — every scripted CLI run spawns
 * 'running' and flips terminal ~40 fake-ms later; the launch closures observe
 * the flip through waitForProcessCompletion's real 2s poll. `drain()` /
 * `drainUntil()` advance the fake clock until the watched promise/predicate
 * settles.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

/** One scripted CLI run, matched (not FIFO) so concurrent epics stay sane. */
interface ScriptedCliRun {
  /** Debug label so a mismatched script pool is diagnosable. */
  label: string;
  /** Picks the sessions this script may serve (first unconsumed match wins). */
  match: (opts: { mode?: string; prompt?: string; cwd?: string }) => boolean;
  consumed: boolean;
  /** ClaudeResult-shaped payload getStatus serves alongside the status. */
  result: Record<string, unknown> | undefined;
  /** Mutable status served by getStatus (flipped to simulate completion). */
  statusRef: { value: string };
  flipTo: string | null;
}

const cliState = vi.hoisted(() => ({
  scripts: [] as Array<{
    label: string;
    match: (opts: { mode?: string; prompt?: string; cwd?: string }) => boolean;
    consumed: boolean;
    result: Record<string, unknown> | undefined;
    statusRef: { value: string };
    flipTo: string | null;
  }>,
  bySession: new Map<
    string,
    {
      label: string;
      result: Record<string, unknown> | undefined;
      statusRef: { value: string };
    }
  >(),
  starts: [] as Array<{ sessionId: string; label: string }>,
}));

const resolutionMocks = vi.hoisted(() => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null as string | null,
    name: null as string | null,
    model: null as string | null,
  })),
  resolveAgentForDispatch: vi.fn(async () => ({
    provider: "claude-code",
    namedAgentId: null as string | null,
    name: null as string | null,
    model: null as string | null,
  })),
  pickAlternativeReviewProvider: vi.fn(async () => "codex"),
}));

const webhookMock = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn((sessionId: string, opts: unknown, _provider: string) => {
      const o = opts as { mode?: string; prompt?: string; cwd?: string };
      const script = cliState.scripts.find((s) => !s.consumed && s.match(o));
      if (!script) {
        const remaining = cliState.scripts
          .filter((s) => !s.consumed)
          .map((s) => s.label)
          .join(", ");
        throw new Error(
          `night-e2e: no CLI script matches (mode=${o.mode}, cwd=${o.cwd}); remaining: [${remaining}]`
        );
      }
      script.consumed = true;
      cliState.bySession.set(sessionId, script);
      cliState.starts.push({ sessionId, label: script.label });
      // The "CLI run": stays 'running' for ~40 fake-ms, then reaches its
      // scripted terminal status.
      if (script.flipTo) {
        setTimeout(() => {
          if (script.statusRef.value === "running") {
            script.statusRef.value = script.flipTo!;
          }
        }, 40);
      }
    }),
    getStatus: vi.fn((sessionId: string) => {
      const script = cliState.bySession.get(sessionId);
      if (!script) return undefined;
      return { status: script.statusRef.value, result: script.result };
    }),
    cancel: vi.fn(),
  },
}));

const WORKTREE_PATH = "/tmp/night-worktree";
const REPO_PATH = "/repos/night";

vi.mock("@/lib/git/manager", () => ({
  createWorktree: vi.fn(async () => {
    // Small fake-clock pause so dispatch-time writes always precede the
    // session flip (mirrors real worktree latency).
    await new Promise((r) => setTimeout(r, 3));
    return { worktreePath: "/tmp/night-worktree", branchName: "feature/night" };
  }),
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: resolutionMocks.resolveAgentByNamedId,
  resolveAgentForDispatch: resolutionMocks.resolveAgentForDispatch,
}));

vi.mock("@/lib/agent-config/review-segregation", () => ({
  pickAlternativeReviewProvider: resolutionMocks.pickAlternativeReviewProvider,
}));

vi.mock("@/lib/events/emit", () => ({
  emitSessionStarted: vi.fn(),
  emitSessionCompleted: vi.fn(),
  emitSessionFailed: vi.fn(),
  emitTicketMoved: vi.fn(),
}));

vi.mock("@/lib/webhooks/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks/send")>();
  return { ...actual, sendProjectWebhook: webhookMock.send };
});

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("no logs in tests");
    }),
  },
}));

const { db } = await import("@/lib/db");
const {
  projects,
  epics,
  agentSessions,
  userStories,
  ticketDependencies,
  ticketComments,
  reviewComments,
  ticketActivityLog,
  notifications,
  settings,
} = await import("@/lib/db/schema");
const { POST: batchBuildPost } = await import(
  "@/app/api/projects/[projectId]/build/route"
);
const { GET: nightRunsListGet } = await import(
  "@/app/api/projects/[projectId]/build/night-runs/route"
);
const { GET: nightRunDetailGet } = await import(
  "@/app/api/projects/[projectId]/build/night-runs/[runId]/route"
);
const { POST: stopPost } = await import(
  "@/app/api/projects/[projectId]/build/night-runs/[runId]/stop/route"
);
const { nightRunRegistry } = await import("@/lib/night/registry");
const { dagBatchRegistry } = await import("@/lib/agents/dag-batch-registry");
const { pipelineRegistry } = await import("@/lib/pipeline");
const { FORENSIC_COMMENT_HEADING } = await import("@/lib/pipeline/forensic");
const { PIPELINE_MAX_ATTEMPTS_SETTING_KEY } = await import(
  "@/lib/pipeline/constants"
);
const { AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY } = await import(
  "@/lib/agents/scheduler-constants"
);
const { AGENT_ASKED_QUESTION_REASON } = await import(
  "@/lib/workflow/agent-question"
);
const {
  formatNightRunCounts,
  formatNightRunCost,
  nightRunAbortKind,
} = await import("@/components/night/night-run-format");
import type {
  NightRunDetail,
  NightRunListEntry,
} from "@/lib/night/constants";

let counter = 0;

/* ------------------------------------------------------------------ */
/* Harness helpers                                                     */
/* ------------------------------------------------------------------ */

function envelope(text: string, costUsd?: number): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: text,
    ...(costUsd !== undefined ? { total_cost_usd: costUsd } : {}),
  });
}

function cliOk(
  text: string,
  extra: { costUsd?: number; endedWithQuestion?: boolean } = {}
): Record<string, unknown> {
  return {
    success: true,
    result: envelope(text, extra.costUsd),
    duration: 500,
    ...(extra.endedWithQuestion ? { endedWithQuestion: true } : {}),
  };
}

function cliFail(error: string): Record<string, unknown> {
  return { success: false, error, duration: 200 };
}

/** Matcher: a code-writing stage (initial build or fix) of the given epic. */
function codeStage(title: string) {
  return (o: { mode?: string; prompt?: string }) =>
    o.mode === "code" &&
    !o.prompt?.includes("Under Review") &&
    !!o.prompt?.includes(title);
}

/**
 * Matcher: the review stage of the given epic. Reviews run in code mode like
 * builds (the no-edit rule is a prompt contract), so the discriminator is the
 * review prompt's "… Under Review" heading, not the mode.
 */
function reviewStage(title: string) {
  return (o: { mode?: string; prompt?: string; cwd?: string }) =>
    o.mode === "code" &&
    o.cwd === WORKTREE_PATH &&
    !!o.prompt?.includes("Under Review") &&
    !!o.prompt?.includes(title);
}

/** Matcher: the forensic post-mortem of the given epic (repo-root cwd). */
function forensicStage(title: string) {
  return (o: { mode?: string; prompt?: string; cwd?: string }) =>
    o.mode === "plan" && o.cwd !== WORKTREE_PATH && !!o.prompt?.includes(title);
}

function scriptRun(
  label: string,
  match: ScriptedCliRun["match"],
  result: Record<string, unknown> | undefined
): ScriptedCliRun {
  const script: ScriptedCliRun = {
    label,
    match,
    consumed: false,
    result,
    statusRef: { value: "running" },
    flipTo: "completed",
  };
  cliState.scripts.push(script);
  return script;
}

function unconsumedScripts(): string[] {
  return cliState.scripts.filter((s) => !s.consumed).map((s) => s.label);
}

function startLabels(): string[] {
  return cliState.starts.map((s) => s.label);
}

/** Advances the fake clock until the given promise settles. */
async function drain<T>(promise: Promise<T>, maxFakeMs = 120_000): Promise<T> {
  const state: {
    done: boolean;
    ok: boolean;
    value: T | undefined;
    error: unknown;
  } = { done: false, ok: false, value: undefined, error: undefined };
  promise.then(
    (value) => {
      state.done = true;
      state.ok = true;
      state.value = value;
    },
    (error) => {
      state.done = true;
      state.error = error;
    }
  );
  let advanced = 0;
  while (!state.done && advanced < maxFakeMs) {
    await vi.advanceTimersByTimeAsync(250);
    advanced += 250;
  }
  if (!state.done) {
    throw new Error(`night-e2e: promise did not settle within ${maxFakeMs} fake ms`);
  }
  if (!state.ok) throw state.error;
  return state.value as T;
}

/** Advances the fake clock until the predicate returns a truthy value. */
async function drainUntil<T>(
  predicate: () => T | null | undefined | false,
  what: string,
  maxFakeMs = 240_000
): Promise<T> {
  let advanced = 0;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (advanced >= maxFakeMs) {
      throw new Error(`night-e2e: ${what} not reached within ${maxFakeMs} fake ms`);
    }
    await vi.advanceTimersByTimeAsync(250);
    advanced += 250;
  }
}

interface SeededEpic {
  id: string;
  title: string;
  readableId: string;
}

function seedProject(): string {
  counter += 1;
  const projectId = `proj-ne-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: `Night E2E ${counter}`, gitRepoPath: REPO_PATH })
    .run();
  return projectId;
}

function seedEpic(projectId: string, key: string, position: number): SeededEpic {
  const id = `epic-ne-${counter}-${key}`;
  const title = `EPIC_${key.toUpperCase()}_${counter}`;
  const readableId = `E-ne${counter}-${key}`;
  db.insert(epics)
    .values({ id, projectId, title, status: "todo", position, readableId })
    .run();
  return { id, title, readableId };
}

function addDep(projectId: string, ticketId: string, dependsOnTicketId: string): void {
  db.insert(ticketDependencies)
    .values({
      id: `dep-${counter}-${ticketId}-${dependsOnTicketId}`,
      ticketId,
      dependsOnTicketId,
      projectId,
      scopeType: "project",
      scopeId: projectId,
    })
    .run();
}

/** a → (b, c) → d → e, five epics, four waves. */
function seedDiamond() {
  const projectId = seedProject();
  const a = seedEpic(projectId, "a", 0);
  const b = seedEpic(projectId, "b", 1);
  const c = seedEpic(projectId, "c", 2);
  const d = seedEpic(projectId, "d", 3);
  const e = seedEpic(projectId, "e", 4);
  addDep(projectId, b.id, a.id);
  addDep(projectId, c.id, a.id);
  addDep(projectId, d.id, b.id);
  addDep(projectId, d.id, c.id);
  addDep(projectId, e.id, d.id);
  return { projectId, a, b, c, d, e };
}

interface NightDispatchData {
  sessions: string[];
  count: number;
  orchestrationMode: string;
  batchId: string;
  waves: number;
  totalEpics: number;
  failurePolicy: string;
  pipeline: boolean;
}

async function dispatchNight(
  projectId: string,
  epicIds: string[],
  extra: Record<string, unknown> = {}
): Promise<NightDispatchData> {
  const res = await drain(
    batchBuildPost(
      mockJsonRequest({ epicIds, mode: "dag", pipeline: true, ...extra }),
      mockRouteContext({ projectId })
    )
  );
  expect(res.status).toBe(200);
  const json = await drain(res.json());
  return json.data as NightDispatchData;
}

/** Advances fake time until the night run reaches its terminal ring. */
async function waitForNightFinished(runId: string) {
  const snapshot = await drainUntil(
    () => {
      const run = nightRunRegistry.get(runId);
      return run && run.state === "finished" ? run : null;
    },
    `terminal state of night run ${runId}`
  );
  // A little more fake time so engineDone + webhooks fully unwind.
  await vi.advanceTimersByTimeAsync(500);
  return snapshot;
}

async function fetchNightDetail(
  projectId: string,
  runId: string
): Promise<NightRunDetail> {
  const res = await nightRunDetailGet(
    mockJsonRequest(null),
    mockRouteContext({ projectId, runId })
  );
  expect(res.status).toBe(200);
  return (await res.json()).data as NightRunDetail;
}

async function fetchNightList(projectId: string): Promise<NightRunListEntry[]> {
  const res = await nightRunsListGet(
    mockJsonRequest(null),
    mockRouteContext({ projectId })
  );
  expect(res.status).toBe(200);
  return (await res.json()).data as NightRunListEntry[];
}

function nightNotifications(projectId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.projectId, projectId))
    .all()
    .filter((n) => n.title?.startsWith("Night run finished"));
}

function nightWebhookCalls() {
  return webhookMock.send.mock.calls.filter(
    (call) => (call[1] as { event?: string }).event === "night_run.completed"
  );
}

function epicRow(epicId: string) {
  return db.select().from(epics).where(eq(epics.id, epicId)).get()!;
}

function projectSessions(projectId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .all();
}

function activityReasons(epicId: string): Array<string | null> {
  return db
    .select()
    .from(ticketActivityLog)
    .where(eq(ticketActivityLog.epicId, epicId))
    .all()
    .map((row) => row.reason);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  cliState.scripts.length = 0;
  cliState.bySession.clear();
  cliState.starts.length = 0;
  resolutionMocks.resolveAgentByNamedId.mockReturnValue({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  });
  resolutionMocks.resolveAgentForDispatch.mockResolvedValue({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  });
  resolutionMocks.pickAlternativeReviewProvider.mockResolvedValue("codex");

  // Fresh tables (children before parents for the foreign keys).
  db.delete(ticketActivityLog).run();
  db.delete(notifications).run();
  db.delete(reviewComments).run();
  db.delete(ticketComments).run();
  db.delete(agentSessions).run();
  db.delete(ticketDependencies).run();
  db.delete(userStories).run();
  db.delete(epics).run();
  db.delete(projects).run();
  db.delete(settings).run();

  // Wide scheduler budget so full waves actually run concurrently.
  db.insert(settings)
    .values({ key: AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY, value: "8" })
    .run();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* (a) diamond, all clean                                              */
/* ------------------------------------------------------------------ */

describe("night run e2e — clean diamond", () => {
  it("runs 4 waves gated at pipeline terminal, parks everything in review, one notification + one webhook", async () => {
    const { projectId, a, b, c, d, e } = seedDiamond();
    for (const epic of [a, b, c, d, e]) {
      scriptRun(`build-${epic.title}`, codeStage(epic.title), cliOk("Implemented."));
      scriptRun(
        `review-${epic.title}`,
        reviewStage(epic.title),
        cliOk("Overall Verdict: Complete — matches the spec.")
      );
    }

    const data = await dispatchNight(projectId, [a.id, b.id, c.id, d.id, e.id]);
    expect(data).toMatchObject({
      orchestrationMode: "dag",
      pipeline: true,
      failurePolicy: "halt",
      waves: 4,
      totalEpics: 5,
      count: 1,
    });
    expect(data.batchId).toMatch(/^night_/);
    expect(data.sessions).toHaveLength(1);
    const runId = data.batchId;

    // The wave chip feed sees the run under the SAME id while it runs.
    expect(dagBatchRegistry.get(runId)).toMatchObject({ batchId: runId });

    await waitForNightFinished(runId);
    expect(unconsumedScripts()).toEqual([]);

    // Dependency-ordered waves, gated at PIPELINE terminal: a's review runs
    // before b/c even BUILD, and d's review precedes e's build.
    const labels = startLabels();
    const at = (label: string) => labels.indexOf(label);
    expect(at(`build-${a.title}`)).toBe(0);
    expect(at(`review-${a.title}`)).toBeLessThan(at(`build-${b.title}`));
    expect(at(`review-${a.title}`)).toBeLessThan(at(`build-${c.title}`));
    expect(at(`review-${b.title}`)).toBeLessThan(at(`build-${d.title}`));
    expect(at(`review-${c.title}`)).toBeLessThan(at(`build-${d.title}`));
    expect(at(`review-${d.title}`)).toBeLessThan(at(`build-${e.title}`));

    // Success end-state is REVIEW for every epic: nothing auto-approves.
    for (const epic of [a, b, c, d, e]) {
      expect(epicRow(epic.id).status).toBe("review");
    }

    // Every session of the run (5 builds + 5 reviews) is tagged.
    const rows = projectSessions(projectId);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.batchRunId).toBe(runId);
      expect(row.status).toBe("completed");
    }

    // Terminal choke point: EXACTLY one summary notification...
    const summaries = nightNotifications(projectId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      title: "Night run finished: 5 in review",
      status: "completed",
      sessionId: null,
      agentType: "build",
      targetUrl: `/projects/${projectId}?nightRun=${runId}`,
    });

    // ...and EXACTLY one night_run.completed webhook.
    const hooks = nightWebhookCalls();
    expect(hooks).toHaveLength(1);
    expect(hooks[0][0]).toBe(projectId);
    expect(hooks[0][1]).toMatchObject({
      event: "night_run.completed",
      summary: "Night run finished: 5 in review",
      error: null,
      path: `/projects/${projectId}?nightRun=${runId}`,
    });

    // Monitor cleanup: the wave chip entry is gone once the run finished.
    expect(dagBatchRegistry.get(runId)).toBeNull();

    // GET detail — the morning summary the dialog renders.
    const detail = await fetchNightDetail(projectId, runId);
    expect(detail).toMatchObject({
      runId,
      projectId,
      source: "registry",
      interrupted: false,
      state: "finished",
      failurePolicy: "halt",
      totalWaves: 4,
      currentWave: 4,
      abortReason: null,
      abortedAtWave: null,
      breakerThreshold: 3,
      costCapUsd: null,
    });
    expect(detail.endedAt).toBeTruthy();
    expect(detail.counts).toEqual({
      pending: 0,
      running: 0,
      done: 5,
      asked: 0,
      failed: 0,
      skipped: 0,
    });
    expect(detail.epics).toHaveLength(5);
    const entryA = detail.epics.find((entry) => entry.epicId === a.id)!;
    expect(entryA).toMatchObject({
      status: "done",
      reason: null,
      readableId: a.readableId,
      title: a.title,
    });
    expect(entryA.sessionIds).toHaveLength(2);
    expect(entryA.pipelineRunId).toBeTruthy();
    // The run's pipeline is real and terminal.
    expect(pipelineRegistry.get(entryA.pipelineRunId!)).toMatchObject({
      state: "succeeded",
      epicId: a.id,
    });

    // No costs reported (envelopes carried none): 0 total, flagged partial.
    expect(detail.totalCostUsd).toBe(0);
    expect(detail.costIsPartial).toBe(true);

    // GET list — the board shortcut's data source.
    const list = await fetchNightList(projectId);
    const listEntry = list.find((entry) => entry.runId === runId)!;
    expect(listEntry).toMatchObject({
      state: "finished",
      interrupted: false,
      source: "registry",
    });

    // Client formatter renders the same headline as the server title.
    expect(`Night run finished: ${formatNightRunCounts(detail.counts)}`).toBe(
      summaries[0].title
    );
  });
});

/* ------------------------------------------------------------------ */
/* (b) one pipeline fails — dependents skip, breaker stays quiet       */
/* ------------------------------------------------------------------ */

describe("night run e2e — single failure under halt", () => {
  it("skips the failed epic's subtree, finishes independent branches, no breaker trip at threshold 3", async () => {
    const { projectId, a, b, c, d, e } = seedDiamond();
    // One attempt per stage keeps the failure ladder short: build fails
    // once → forensic → pipeline failed.
    db.insert(settings)
      .values({ key: PIPELINE_MAX_ATTEMPTS_SETTING_KEY, value: "1" })
      .run();

    scriptRun(`build-${a.title}`, codeStage(a.title), cliOk("Implemented."));
    scriptRun(`review-${a.title}`, reviewStage(a.title), cliOk("Overall Verdict: Complete."));
    scriptRun(`build-${b.title}`, codeStage(b.title), cliFail("tsc exploded"));
    scriptRun(
      `forensic-${b.title}`,
      forensicStage(b.title),
      cliOk("Diagnostic: the build died on a type error.")
    );
    scriptRun(`build-${c.title}`, codeStage(c.title), cliOk("Implemented."));
    scriptRun(`review-${c.title}`, reviewStage(c.title), cliOk("Overall Verdict: Complete."));

    const data = await dispatchNight(projectId, [a.id, b.id, c.id, d.id, e.id]);
    const runId = data.batchId;
    await waitForNightFinished(runId);

    // d and e never got a session; every prepared script ran.
    expect(unconsumedScripts()).toEqual([]);
    expect(startLabels().some((l) => l.includes(d.title))).toBe(false);
    expect(startLabels().some((l) => l.includes(e.title))).toBe(false);

    // Board state: a and c delivered to review, b stranded in progress
    // (failed build never advances a ticket), d/e untouched.
    expect(epicRow(a.id).status).toBe("review");
    expect(epicRow(c.id).status).toBe("review");
    expect(epicRow(b.id).status).toBe("in_progress");
    expect(epicRow(d.id).status).toBe("todo");
    expect(epicRow(e.id).status).toBe("todo");

    const detail = await fetchNightDetail(projectId, runId);
    expect(detail.counts).toEqual({
      pending: 0,
      running: 0,
      done: 2,
      asked: 0,
      failed: 1,
      skipped: 2,
    });
    // Breaker (default threshold 3) did NOT trip: c's success resets the
    // streak and one failure is not three.
    expect(detail.abortReason).toBeNull();
    expect(detail.abortedAtWave).toBeNull();

    const entryB = detail.epics.find((entry) => entry.epicId === b.id)!;
    expect(entryB.status).toBe("failed");
    expect(entryB.reason).toBe("stage build failed after 1 attempts");
    // The forensic session is run-tagged but not epic-attached.
    expect(entryB.sessionIds).toHaveLength(1);

    const entryD = detail.epics.find((entry) => entry.epicId === d.id)!;
    expect(entryD.status).toBe("skipped");
    expect(entryD.reason).toBe(`dependency ${b.id} failed`);
    const entryE = detail.epics.find((entry) => entry.epicId === e.id)!;
    expect(entryE.status).toBe("skipped");
    expect(entryE.reason).toBe(`dependency ${b.id} failed`);

    // Skip decisions are logged on the held tickets with the readable ref.
    expect(activityReasons(d.id)).toContain(
      `skipped: dependency ${b.readableId} failed`
    );
    expect(activityReasons(e.id)).toContain(
      `skipped: dependency ${b.readableId} failed`
    );

    // Forensic ran: tagged session without epicId + diagnostic comment on b.
    const forensicRows = projectSessions(projectId).filter(
      (row) => row.agentType === "forensic"
    );
    expect(forensicRows).toHaveLength(1);
    expect(forensicRows[0].batchRunId).toBe(runId);
    expect(forensicRows[0].epicId).toBeNull();
    const bComments = db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, b.id))
      .all();
    expect(
      bComments.some((row) => row.content.includes(FORENSIC_COMMENT_HEADING))
    ).toBe(true);

    const summaries = nightNotifications(projectId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      title: "Night run finished: 2 in review, 1 failed, 2 skipped",
      status: "failed",
    });
    expect(nightWebhookCalls()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* (c) circuit breaker trips mid-run                                   */
/* ------------------------------------------------------------------ */

describe("night run e2e — circuit breaker", () => {
  it("three consecutive pipeline failures abort the remaining waves; in-flight epics settle", async () => {
    const projectId = seedProject();
    const f1 = seedEpic(projectId, "f1", 0);
    const f2 = seedEpic(projectId, "f2", 1);
    const f3 = seedEpic(projectId, "f3", 2);
    const s = seedEpic(projectId, "s", 3);
    const g = seedEpic(projectId, "g", 4);
    // g depends on the SUCCESSFUL epic only: under halt it would build in
    // wave 2 — only the breaker abort can stop it.
    addDep(projectId, g.id, s.id);
    db.insert(settings)
      .values({ key: PIPELINE_MAX_ATTEMPTS_SETTING_KEY, value: "1" })
      .run();

    for (const f of [f1, f2, f3]) {
      scriptRun(`build-${f.title}`, codeStage(f.title), cliFail("broken"));
      scriptRun(`forensic-${f.title}`, forensicStage(f.title), cliOk("Diagnostic."));
    }
    scriptRun(`build-${s.title}`, codeStage(s.title), cliOk("Implemented."));
    scriptRun(`review-${s.title}`, reviewStage(s.title), cliOk("Overall Verdict: Complete."));

    const data = await dispatchNight(
      projectId,
      [f1.id, f2.id, f3.id, s.id, g.id],
      { circuitBreaker: 3 }
    );
    expect(data.waves).toBe(2);
    const runId = data.batchId;
    await waitForNightFinished(runId);

    // Wave 2 never launched; the in-flight wave settled completely (s's
    // pipeline finished: epic delivered to review).
    expect(unconsumedScripts()).toEqual([]);
    expect(startLabels().some((l) => l.includes(g.title))).toBe(false);
    expect(epicRow(s.id).status).toBe("review");
    expect(epicRow(g.id).status).toBe("todo");

    const breakerReason = "circuit breaker: 3 consecutive pipeline failures";
    const detail = await fetchNightDetail(projectId, runId);
    expect(detail.abortReason).toBe(breakerReason);
    expect(detail.abortedAtWave).toBe(1);
    expect(detail.breakerThreshold).toBe(3);
    expect(nightRunAbortKind(detail.abortReason)).toBe("breaker");
    expect(detail.counts).toEqual({
      pending: 0,
      running: 0,
      done: 1,
      asked: 0,
      failed: 3,
      skipped: 1,
    });

    // The aborted epic carries the breaker reason VERBATIM — registry,
    // detail entry, and activity log all agree.
    const entryG = detail.epics.find((entry) => entry.epicId === g.id)!;
    expect(entryG.status).toBe("skipped");
    expect(entryG.reason).toBe(breakerReason);
    expect(activityReasons(g.id)).toContain(breakerReason);

    // All three failures got their post-mortem before the run closed.
    expect(
      projectSessions(projectId).filter((row) => row.agentType === "forensic")
    ).toHaveLength(3);

    const summaries = nightNotifications(projectId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      title:
        "Night run finished: 1 in review, 3 failed, 1 skipped — circuit breaker tripped",
      status: "failed",
    });

    const hooks = nightWebhookCalls();
    expect(hooks).toHaveLength(1);
    expect(hooks[0][1]).toMatchObject({ error: breakerReason });
  });
});

/* ------------------------------------------------------------------ */
/* (d) a review asks a question                                        */
/* ------------------------------------------------------------------ */

describe("night run e2e — asked question", () => {
  it("pauses the epic's pipeline, holds the ticket, skips dependents, and keeps independent epics building", async () => {
    const projectId = seedProject();
    const q = seedEpic(projectId, "q", 0);
    const i = seedEpic(projectId, "i", 1);
    const r = seedEpic(projectId, "r", 2);
    addDep(projectId, r.id, q.id);

    scriptRun(`build-${q.title}`, codeStage(q.title), cliOk("Implemented."));
    scriptRun(
      `review-${q.title}`,
      reviewStage(q.title),
      cliOk("Should sessions expire after 15 minutes or 24 hours?", {
        endedWithQuestion: true,
      })
    );
    scriptRun(`build-${i.title}`, codeStage(i.title), cliOk("Implemented."));
    scriptRun(`review-${i.title}`, reviewStage(i.title), cliOk("Overall Verdict: Complete."));

    const data = await dispatchNight(projectId, [q.id, i.id, r.id]);
    const runId = data.batchId;
    await waitForNightFinished(runId);
    expect(unconsumedScripts()).toEqual([]);

    // The ticket is HELD where the question found it (review), the asked
    // outcome is on the review session, and the hold was logged.
    expect(epicRow(q.id).status).toBe("review");
    const qReview = projectSessions(projectId).find(
      (row) => row.epicId === q.id && row.agentType !== "build"
    )!;
    expect(qReview.outcome).toBe("asked_question");
    expect(activityReasons(q.id)).toContain(AGENT_ASKED_QUESTION_REASON);

    // Independent branch finished; the dependent never launched.
    expect(epicRow(i.id).status).toBe("review");
    expect(epicRow(r.id).status).toBe("todo");
    expect(startLabels().some((l) => l.includes(r.title))).toBe(false);

    const detail = await fetchNightDetail(projectId, runId);
    expect(detail.counts).toEqual({
      pending: 0,
      running: 0,
      done: 1,
      asked: 1,
      failed: 0,
      skipped: 1,
    });
    expect(detail.abortReason).toBeNull();

    const entryQ = detail.epics.find((entry) => entry.epicId === q.id)!;
    expect(entryQ.status).toBe("asked");
    // The night entry's pipelineRunId points at a REAL paused run.
    expect(pipelineRegistry.get(entryQ.pipelineRunId!)).toMatchObject({
      state: "paused_question",
      epicId: q.id,
    });

    const entryR = detail.epics.find((entry) => entry.epicId === r.id)!;
    expect(entryR.status).toBe("skipped");
    expect(entryR.reason).toBe(`dependency ${q.id} asked a question`);
    expect(activityReasons(r.id)).toContain(
      `skipped: dependency ${q.readableId} asked a question`
    );

    // A question is not a failure: the run completes cleanly.
    const summaries = nightNotifications(projectId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      title: "Night run finished: 1 in review, 1 paused, 1 skipped",
      status: "completed",
    });
    expect(nightWebhookCalls()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* (e) cost cap                                                        */
/* ------------------------------------------------------------------ */

describe("night run e2e — cost cap", () => {
  it("sums Claude-reported envelope costs and aborts the remaining waves at the cap", async () => {
    const projectId = seedProject();
    const c1 = seedEpic(projectId, "c1", 0);
    const c2 = seedEpic(projectId, "c2", 1);
    addDep(projectId, c2.id, c1.id);

    // 3.25 + 2.50 = 5.75 (exact in binary) — crosses the $5 cap.
    scriptRun(
      `build-${c1.title}`,
      codeStage(c1.title),
      cliOk("Implemented.", { costUsd: 3.25 })
    );
    scriptRun(
      `review-${c1.title}`,
      reviewStage(c1.title),
      cliOk("Overall Verdict: Complete.", { costUsd: 2.5 })
    );

    const data = await dispatchNight(projectId, [c1.id, c2.id], {
      costCapUsd: 5,
    });
    expect(data.waves).toBe(2);
    const runId = data.batchId;
    await waitForNightFinished(runId);
    expect(unconsumedScripts()).toEqual([]);

    // The envelope costs landed on the session rows (the REAL usage path).
    const rows = projectSessions(projectId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.totalCostUsd).sort()).toEqual([2.5, 3.25]);

    const abortReason = "cost cap reached: $5.75 of $5.00";
    const detail = await fetchNightDetail(projectId, runId);
    expect(detail.abortReason).toBe(abortReason);
    expect(detail.abortedAtWave).toBe(1);
    expect(detail.costCapUsd).toBe(5);
    expect(nightRunAbortKind(detail.abortReason)).toBe("cost");
    expect(detail.totalCostUsd).toBeCloseTo(5.75, 10);
    // EVERY tagged session reported a cost → the total is exact, not "≥".
    expect(detail.costIsPartial).toBe(false);

    const entryC1 = detail.epics.find((entry) => entry.epicId === c1.id)!;
    expect(entryC1.status).toBe("done");
    expect(entryC1.costUsd).toBeCloseTo(5.75, 10);
    const entryC2 = detail.epics.find((entry) => entry.epicId === c2.id)!;
    expect(entryC2.status).toBe("skipped");
    expect(entryC2.reason).toBe(abortReason);
    expect(epicRow(c2.id).status).toBe("todo");

    // Title carries the exact cost and the cap marker; the client-side
    // formatters produce the same wording the server persisted.
    const summaries = nightNotifications(projectId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe(
      "Night run finished: 1 in review, 1 skipped — $5.75 — cost cap reached"
    );
    expect(summaries[0].status).toBe("failed");
    expect(
      `Night run finished: ${formatNightRunCounts(detail.counts)} — ${formatNightRunCost(
        detail.totalCostUsd,
        detail.costIsPartial
      )} — cost cap reached`
    ).toBe(summaries[0].title);

    const hooks = nightWebhookCalls();
    expect(hooks).toHaveLength(1);
    expect(hooks[0][1]).toMatchObject({ error: abortReason });
  });
});

/* ------------------------------------------------------------------ */
/* (f) interrupted-run derivation (registry lost, DB remains)          */
/* ------------------------------------------------------------------ */

describe("night run e2e — interrupted run derived from the database", () => {
  it("rebuilds the morning story from tagged sessions with interrupted: true", async () => {
    const projectId = seedProject();
    const x = seedEpic(projectId, "x", 0);
    const y = seedEpic(projectId, "y", 1);
    const z = seedEpic(projectId, "z", 2);
    const runId = `night_interrupted_${counter}`;

    // The sessions a dead server left behind: boot cleanup already moved
    // running orphans to cancelled/failed. The registry knows nothing.
    const insert = (row: Record<string, unknown>) =>
      db.insert(agentSessions).values(row as never).run();
    insert({
      id: `sx1-${counter}`,
      projectId,
      epicId: x.id,
      agentType: "build",
      status: "completed",
      outcome: "answered",
      batchRunId: runId,
      totalCostUsd: 1.5,
      createdAt: "2026-08-16T22:00:00.000Z",
      completedAt: "2026-08-16T22:10:00.000Z",
    });
    insert({
      id: `sx2-${counter}`,
      projectId,
      epicId: x.id,
      agentType: "review_code",
      status: "completed",
      outcome: "answered",
      batchRunId: runId,
      totalCostUsd: null,
      createdAt: "2026-08-16T22:15:00.000Z",
      completedAt: "2026-08-16T22:25:00.000Z",
    });
    insert({
      id: `sy1-${counter}`,
      projectId,
      epicId: y.id,
      agentType: "build",
      status: "completed",
      outcome: "asked_question",
      batchRunId: runId,
      createdAt: "2026-08-16T22:05:00.000Z",
      completedAt: "2026-08-16T22:30:00.000Z",
    });
    insert({
      id: `sz1-${counter}`,
      projectId,
      epicId: z.id,
      agentType: "build",
      status: "cancelled",
      outcome: null,
      batchRunId: runId,
      createdAt: "2026-08-16T22:06:00.000Z",
      completedAt: "2026-08-16T22:31:00.000Z",
    });
    // Forensic-style row: run-tagged, no epic — counts for cost/partiality
    // and the time window, never as an epic entry.
    insert({
      id: `sw-${counter}`,
      projectId,
      agentType: "forensic",
      status: "completed",
      outcome: "answered",
      batchRunId: runId,
      createdAt: "2026-08-16T22:20:00.000Z",
      completedAt: "2026-08-16T22:35:00.000Z",
    });
    // Decoy: "nightmare_run" matches LIKE 'night_%' (SQL `_` wildcard) but
    // is NOT a night run — the JS re-filter must drop it.
    insert({
      id: `sdecoy-${counter}`,
      projectId,
      epicId: x.id,
      agentType: "build",
      status: "completed",
      outcome: "answered",
      batchRunId: "nightmare_run",
      createdAt: "2026-08-16T21:00:00.000Z",
      completedAt: "2026-08-16T21:05:00.000Z",
    });

    expect(nightRunRegistry.get(runId)).toBeNull();

    // List: exactly the interrupted run, rebuilt from the DB.
    const list = await fetchNightList(projectId);
    expect(list.map((entry) => entry.runId)).toEqual([runId]);
    expect(list[0]).toMatchObject({
      source: "db",
      interrupted: true,
      state: "finished",
      totalCostUsd: 1.5,
    });
    expect(list[0].counts).toEqual({
      pending: 0,
      running: 0,
      done: 1,
      asked: 1,
      failed: 1,
      skipped: 0,
    });

    // Detail: per-epic stories from each epic's LAST tagged session.
    const detail = await fetchNightDetail(projectId, runId);
    expect(detail).toMatchObject({
      runId,
      projectId,
      source: "db",
      interrupted: true,
      state: "finished",
      failurePolicy: null,
      totalWaves: null,
      currentWave: null,
      abortReason: null,
      breakerThreshold: null,
      costCapUsd: null,
      startedAt: "2026-08-16T22:00:00.000Z",
      endedAt: "2026-08-16T22:35:00.000Z",
    });
    expect(detail.totalCostUsd).toBeCloseTo(1.5, 10);
    expect(detail.costIsPartial).toBe(true);
    expect(detail.epics).toHaveLength(3);

    const entryX = detail.epics.find((entry) => entry.epicId === x.id)!;
    expect(entryX).toMatchObject({
      status: "done",
      readableId: x.readableId,
      title: x.title,
      pipelineRunId: null,
    });
    expect(entryX.sessionIds).toEqual([`sx1-${counter}`, `sx2-${counter}`]);
    expect(entryX.costUsd).toBeCloseTo(1.5, 10);

    expect(
      detail.epics.find((entry) => entry.epicId === y.id)!.status
    ).toBe("asked");
    expect(
      detail.epics.find((entry) => entry.epicId === z.id)!.status
    ).toBe("failed");

    // Cross-project isolation: the same run id under another project 404s.
    const otherProjectId = seedProject();
    const crossRes = await nightRunDetailGet(
      mockJsonRequest(null),
      mockRouteContext({ projectId: otherProjectId, runId })
    );
    expect(crossRes.status).toBe(404);

    // Unknown run id 404s too.
    const missingRes = await nightRunDetailGet(
      mockJsonRequest(null),
      mockRouteContext({ projectId, runId: "night_missing" })
    );
    expect(missingRes.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* (g) the user stops the run mid-wave                                 */
/* ------------------------------------------------------------------ */

describe("night run e2e — user stop", () => {
  it("stops at the wave boundary: the in-flight pipeline finishes, the rest is skipped 'stopped by user'", async () => {
    const projectId = seedProject();
    const p = seedEpic(projectId, "p", 0);
    const q = seedEpic(projectId, "q", 1);
    const r = seedEpic(projectId, "r", 2);
    // Both depend on p, so they sit in wave 2. p's pipeline SUCCEEDS, which
    // means nothing blocks them: only the stop can keep them from launching.
    addDep(projectId, q.id, p.id);
    addDep(projectId, r.id, p.id);

    scriptRun(`build-${p.title}`, codeStage(p.title), cliOk("Implemented.", { costUsd: 0.5 }));
    scriptRun(
      `review-${p.title}`,
      reviewStage(p.title),
      cliOk("Overall Verdict: Complete.", { costUsd: 0.25 })
    );
    // Deliberately NO scripts for q and r: if the stop failed to hold them
    // back, the process-manager mock throws "no CLI script matches".

    const data = await dispatchNight(projectId, [p.id, q.id, r.id]);
    expect(data.waves).toBe(2);
    const runId = data.batchId;

    // Wave 1 is in flight (p's build session exists) — hit Stop now.
    await drainUntil(
      () => cliState.starts.some((s) => s.label === `build-${p.title}`),
      "p's build session to start"
    );
    const stopRes = await stopPost(
      mockJsonRequest(null),
      mockRouteContext({ projectId, runId })
    );
    expect(stopRes.status).toBe(200);
    expect(await stopRes.json()).toEqual({ data: { stopping: true } });

    // The live detail says "stopping" while the wave is still settling.
    const midRun = await fetchNightDetail(projectId, runId);
    expect(midRun.state).toBe("running");
    expect(midRun.stopRequested).toBe(true);

    await waitForNightFinished(runId);

    // p's ENTIRE pipeline ran (build AND review consumed) — a stop never
    // force-cancels in-flight work, so p still lands in Review.
    expect(unconsumedScripts()).toEqual([]);
    expect(startLabels()).toEqual([`build-${p.title}`, `review-${p.title}`]);
    expect(epicRow(p.id).status).toBe("review");
    // q and r never launched and never moved.
    expect(epicRow(q.id).status).toBe("todo");
    expect(epicRow(r.id).status).toBe("todo");

    const detail = await fetchNightDetail(projectId, runId);
    expect(detail.state).toBe("finished");
    expect(detail.abortReason).toBe("stopped by user");
    expect(detail.abortedAtWave).toBe(1);
    expect(nightRunAbortKind(detail.abortReason)).toBe("stopped");
    expect(detail.counts).toEqual({
      pending: 0,
      running: 0,
      done: 1,
      asked: 0,
      failed: 0,
      skipped: 2,
    });

    for (const epic of [q, r]) {
      const entry = detail.epics.find((e) => e.epicId === epic.id)!;
      expect(entry.status).toBe("skipped");
      expect(entry.reason).toBe("stopped by user");
      expect(activityReasons(epic.id)).toContain("stopped by user");
    }

    // Exactly one summary notification, in the stopped variant, and one
    // webhook — the terminal choke point behaves like any other abort.
    const summaries = nightNotifications(projectId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].title).toBe(
      `Night run finished: ${formatNightRunCounts(detail.counts)} — ${formatNightRunCost(detail.totalCostUsd, detail.costIsPartial)} — stopped by you`
    );
    const hooks = nightWebhookCalls();
    expect(hooks).toHaveLength(1);
    expect(hooks[0][1]).toMatchObject({ error: "stopped by user" });

    // Stopping a run that already closed is a 404.
    const lateRes = await stopPost(
      mockJsonRequest(null),
      mockRouteContext({ projectId, runId })
    );
    expect(lateRes.status).toBe(404);
  });
});
