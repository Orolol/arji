/**
 * GET/PUT /api/projects/[projectId]/auto-mode against the migrated schema.
 *
 * The engine kick is mocked (a real sweep would dispatch agents); everything
 * else — the settings writes, the resolver chain, the registry snapshot and
 * the candidate counts — is real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const engineMocks = vi.hoisted(() => ({ kickAutoMode: vi.fn() }));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/auto-mode/engine", () => ({
  kickAutoMode: engineMocks.kickAutoMode,
}));

const { db } = await import("@/lib/db");
const { projects, epics, agentSessions, settings } = await import(
  "@/lib/db/schema"
);
const { GET, PUT } = await import(
  "@/app/api/projects/[projectId]/auto-mode/route"
);
const { autoModeRegistry } = await import("@/lib/auto-mode/registry");
const { AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY } = await import(
  "@/lib/agents/scheduler-constants"
);
const {
  autoModeBuildConcurrencySettingKey,
  autoModeEnabledSettingKey,
  autoModeReviewAgentSettingKey,
  autoModeReviewConcurrencySettingKey,
    autoModeBuildAgentSettingKey,
    fullAutoSecondOpinionSettingKey,
} = await import("@/lib/auto-mode/constants");

const PROJECT_ID = "proj-route";

function params(projectId = PROJECT_ID) {
  return { params: Promise.resolve({ projectId }) };
}

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function settingValue(key: string): unknown {
  const row = db.select().from(settings).all().find((r) => r.key === key);
  return row ? JSON.parse(row.value) : undefined;
}

beforeEach(() => {
  db.delete(agentSessions).run();
  db.delete(epics).run();
  db.delete(projects).run();
  db.delete(settings).run();
  autoModeRegistry.resetAll();
  engineMocks.kickAutoMode.mockClear();

  db.insert(projects)
    .values({ id: PROJECT_ID, name: "Route", gitRepoPath: "/repos/route" })
    .run();
});

describe("GET /auto-mode", () => {
  it("404s on an unknown project", async () => {
    const res = await GET({} as never, params("nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Project not found");
  });

  it("returns the full status shape with defaults", async () => {
    const res = await GET({} as never, params());
    const { data } = await res.json();

    expect(data).toMatchObject({
      enabled: false,
      buildAgent: null,
      buildConcurrency: 2,
      reviewAgent: null,
      reviewConcurrency: 1,
      secondOpinion: false,
      // Unlimited (Infinity in-process) crosses JSON as an explicit null.
      effectiveSchedulerBudget: null,
      running: false,
      inFlight: { build: 0, review: 0 },
      candidates: { build: 0, review: 0, merge: 0 },
      parked: [],
      recentDispatches: [],
    });
  });

  it("reports live candidate counts, in-flight work and parked tickets", async () => {
    db.insert(epics)
      .values([
        {
          id: "e-todo",
          projectId: PROJECT_ID,
          title: "Todo",
          status: "todo",
          position: 0,
        },
        {
          id: "e-review",
          projectId: PROJECT_ID,
          title: "Review",
          status: "review",
          position: 1,
        },
        {
          id: "e-parked",
          projectId: PROJECT_ID,
          title: "Parked",
          status: "todo",
          position: 2,
        },
      ])
      .run();

    autoModeRegistry.setEnabled(PROJECT_ID, true);
    autoModeRegistry.addInFlight(PROJECT_ID, "s-build", {
      kind: "build",
      ticketId: "e-other",
      epicId: "e-other",
    });
    autoModeRegistry.park(PROJECT_ID, "e-parked", "e-parked", "boom");

    const res = await GET({} as never, params());
    const { data } = await res.json();

    expect(data.candidates).toEqual({ build: 1, review: 1, merge: 0 });
    expect(data.inFlight).toEqual({ build: 1, review: 0 });
    expect(data.running).toBe(true);
    expect(data.parked).toEqual([
      expect.objectContaining({ ticketId: "e-parked", failures: 3 }),
    ]);
  });

  it("reports the project's effective scheduler budget", async () => {
    db.insert(settings)
      .values({
        key: AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY,
        value: JSON.stringify(6),
      })
      .run();

    const { data } = await (await GET({} as never, params())).json();
    expect(data.effectiveSchedulerBudget).toBe(6);
  });
});

describe("PUT /auto-mode", () => {
  it("404s on an unknown project", async () => {
    const res = await PUT(putRequest({ enabled: true }) as never, params("nope"));
    expect(res.status).toBe(404);
  });

  it("persists all seven settings keys and returns the new state", async () => {
    const res = await PUT(
      putRequest({
        enabled: true,
        buildAgent: "agent-build",
        buildConcurrency: 4,
        reviewAgent: "agent-review",
        reviewConcurrency: 2,
        smartDispatch: true,
        secondOpinion: true,
      }) as never,
      params()
    );
    const { data } = await res.json();

    expect(settingValue(autoModeEnabledSettingKey(PROJECT_ID))).toBe(true);
    expect(settingValue(autoModeBuildAgentSettingKey(PROJECT_ID))).toBe(
      "agent-build"
    );
    expect(settingValue(autoModeBuildConcurrencySettingKey(PROJECT_ID))).toBe(4);
    expect(settingValue(autoModeReviewAgentSettingKey(PROJECT_ID))).toBe(
      "agent-review"
    );
    expect(settingValue(autoModeReviewConcurrencySettingKey(PROJECT_ID))).toBe(
      2
    );
    expect(settingValue(fullAutoSecondOpinionSettingKey(PROJECT_ID))).toBe(true);

    expect(data).toMatchObject({
      enabled: true,
      buildAgent: "agent-build",
      buildConcurrency: 4,
      reviewAgent: "agent-review",
      reviewConcurrency: 2,
      smartDispatch: true,
      secondOpinion: true,
    });
  });

  it("triggers an immediate sweep instead of waiting for the next tick", async () => {
    await PUT(putRequest({ enabled: true }) as never, params());
    expect(engineMocks.kickAutoMode).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("returns runtime fields that already reflect the change, not the last sweep", async () => {
    const enabled = await (
      await PUT(putRequest({ enabled: true }) as never, params())
    ).json();
    // The sweep is deferred, so the response must not report `running: false`
    // just because no tick has happened yet.
    expect(enabled.data.running).toBe(true);
    expect(autoModeRegistry.isEnabled(PROJECT_ID)).toBe(true);

    autoModeRegistry.addInFlight(PROJECT_ID, "s1", {
      kind: "build",
      ticketId: "e1",
      epicId: "e1",
    });

    const disabled = await (
      await PUT(putRequest({ enabled: false }) as never, params())
    ).json();
    expect(disabled.data.running).toBe(false);
    expect(disabled.data.inFlight).toEqual({ build: 0, review: 0 });
    expect(autoModeRegistry.isEnabled(PROJECT_ID)).toBe(false);
  });

  it("accepts a partial payload without clobbering the other keys", async () => {
    await PUT(
      putRequest({ enabled: true, buildConcurrency: 5 }) as never,
      params()
    );
    await PUT(putRequest({ enabled: false }) as never, params());

    expect(settingValue(autoModeEnabledSettingKey(PROJECT_ID))).toBe(false);
    expect(settingValue(autoModeBuildConcurrencySettingKey(PROJECT_ID))).toBe(5);
  });

  it("clamps concurrency on write", async () => {
    const { data } = await (
      await PUT(
        putRequest({ buildConcurrency: 42, reviewConcurrency: -1 }) as never,
        params()
      )
    ).json();

    expect(data.buildConcurrency).toBe(10);
    expect(data.reviewConcurrency).toBe(0);
    expect(settingValue(autoModeBuildConcurrencySettingKey(PROJECT_ID))).toBe(
      10
    );
  });

  it("rejects a non-boolean enabled and a non-integer concurrency", async () => {
    const badEnabled = await PUT(
      putRequest({ enabled: "maybe" }) as never,
      params()
    );
    expect(badEnabled.status).toBe(400);

    const badConcurrency = await PUT(
      putRequest({ buildConcurrency: "lots" }) as never,
      params()
    );
    expect(badConcurrency.status).toBe(400);

    const badSecondOpinion = await PUT(
      putRequest({ secondOpinion: "sometimes" }) as never,
      params()
    );
    expect(badSecondOpinion.status).toBe(400);
  });

  it("writes NOTHING when any field of the payload is invalid", async () => {
    // The dangerous shape: a valid `enabled: true` in front of an invalid
    // field. Writing as we validated would arm an unattended supervisor and
    // still answer 400, so the caller believes nothing happened.
    const res = await PUT(
      putRequest({
        enabled: true,
        buildAgent: "agent-1",
        buildConcurrency: "lots",
      }) as never,
      params()
    );

    expect(res.status).toBe(400);
    expect(settingValue(autoModeEnabledSettingKey(PROJECT_ID))).toBeUndefined();
    expect(
      settingValue(autoModeBuildAgentSettingKey(PROJECT_ID))
    ).toBeUndefined();
    expect(autoModeRegistry.isEnabled(PROJECT_ID)).toBe(false);
    expect(engineMocks.kickAutoMode).not.toHaveBeenCalled();
  });

  it("leaves an existing configuration untouched when a later field is invalid", async () => {
    await PUT(
      putRequest({ enabled: false, buildConcurrency: 4 }) as never,
      params()
    );

    const res = await PUT(
      putRequest({ enabled: true, reviewConcurrency: 99.5 }) as never,
      params()
    );

    expect(res.status).toBe(400);
    expect(settingValue(autoModeEnabledSettingKey(PROJECT_ID))).toBe(false);
    expect(settingValue(autoModeBuildConcurrencySettingKey(PROJECT_ID))).toBe(4);
  });

  it("rejects a non-object body", async () => {
    const res = await PUT(
      new Request("http://localhost/api", {
        method: "PUT",
        body: "not json",
      }) as never,
      params()
    );
    expect(res.status).toBe(400);
  });

  it("clears the agent when null is sent", async () => {
    await PUT(putRequest({ buildAgent: "agent-1" }) as never, params());
    expect(settingValue(autoModeBuildAgentSettingKey(PROJECT_ID))).toBe(
      "agent-1"
    );

    const { data } = await (
      await PUT(putRequest({ buildAgent: null }) as never, params())
    ).json();
    expect(data.buildAgent).toBeNull();
  });

  it("never writes the scheduler budget, however large the concurrencies are", async () => {
    await PUT(
      putRequest({
        enabled: true,
        buildConcurrency: 10,
        reviewConcurrency: 10,
      }) as never,
      params()
    );

    const keys = db.select().from(settings).all().map((row) => row.key);
    expect(keys).not.toContain(AGENT_MAX_CONCURRENT_GLOBAL_SETTING_KEY);
    expect(keys.some((key) => key.startsWith("agent_max_concurrent"))).toBe(
      false
    );
  });
});
