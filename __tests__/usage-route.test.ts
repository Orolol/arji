import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import type { ClaudeQuota, CodexLiveQuota } from "@/lib/types/usage";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<
    typeof import("@/lib/db/test-utils").createTestDb
  > | null,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.db;
  },
  get sqlite() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.sqlite;
  },
}));

// The filesystem scan is stubbed out: this test must never touch the user's
// real ~/.codex/sessions tree, and must certainly never spawn a codex process.
vi.mock("@/lib/usage/codex-snapshot", () => ({
  refreshCodexUsageSnapshot: vi.fn(),
  storeCodexLiveSnapshot: vi.fn(),
}));

// The quota cache is mocked at the module seam: route tests must NEVER reach
// the pollers (which would spawn real CLIs). Default = both pollers failed,
// i.e. today's fallback behavior.
vi.mock("@/lib/usage/quota-cache", () => ({
  getClaudeQuotaCached: vi.fn(),
  getCodexQuotaCached: vi.fn(),
}));

// ---- Import route handler AFTER mocks ----
import { GET } from "@/app/api/usage/route";
import { getUsageReport } from "@/lib/usage/aggregate";
import { refreshCodexUsageSnapshot } from "@/lib/usage/codex-snapshot";
import {
  getClaudeQuotaCached,
  getCodexQuotaCached,
} from "@/lib/usage/quota-cache";

const refreshMock = vi.mocked(refreshCodexUsageSnapshot);
const claudeCacheMock = vi.mocked(getClaudeQuotaCached);
const codexCacheMock = vi.mocked(getCodexQuotaCached);

const NO_LIVE = { data: null, capturedAtIso: null };

const CLAUDE_LIVE: ClaudeQuota = {
  subscriptionType: "max",
  fiveHour: { utilizationPercent: 34, resetsAtIso: "2026-08-18T16:00:00+00:00" },
  sevenDay: { utilizationPercent: 61, resetsAtIso: "2026-08-21T09:00:00+00:00" },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  modelScoped: [],
  extraUsage: null,
};

const CODEX_LIVE: CodexLiveQuota = {
  planType: "prolite",
  buckets: [
    {
      limitId: "codex",
      limitName: null,
      usedPercent: 6,
      windowDurationMins: 10080,
      resetsAtUnix: 1787671089,
      secondary: null,
    },
    {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      usedPercent: 2,
      windowDurationMins: 10080,
      resetsAtUnix: 1787671089,
      secondary: null,
    },
  ],
  credits: { hasCredits: false, unlimited: false, balance: "0" },
  dailyUsage: [{ date: "2026-08-18", tokens: 20928692 }],
  lifetimeTokens: 1383498631,
};

function request(fresh = false): Request {
  return new Request(
    fresh ? "http://localhost/api/usage?fresh=1" : "http://localhost/api/usage",
  );
}

function seedSession(id: string, overrides: Record<string, unknown> = {}): void {
  testDb
    .instance!.sqlite.prepare(
      `INSERT INTO agent_sessions (
         id, project_id, status, provider, named_agent_name,
         input_tokens, output_tokens, total_cost_usd, ended_at, created_at
       ) VALUES (
         @id, @projectId, @status, @provider, @namedAgentName,
         @inputTokens, @outputTokens, @totalCostUsd, @endedAt, @createdAt
       )`,
    )
    .run({
      id,
      projectId: "p1",
      status: "completed",
      provider: "claude-code",
      namedAgentName: "Builder",
      inputTokens: 100,
      outputTokens: 10,
      totalCostUsd: 1.25,
      endedAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      ...overrides,
    });
}

function seedSnapshot(): void {
  testDb
    .instance!.sqlite.prepare(
      `INSERT INTO provider_usage_snapshots (
         provider, captured_at, plan_type,
         primary_used_percent, primary_window_minutes, primary_resets_at,
         source_file, raw_json
       ) VALUES (
         'codex', '2026-08-18T09:00:00.000Z', 'prolite',
         6, 10080, 1787671089,
         '/home/u/.codex/sessions/2026/08/18/rollout-x.jsonl', '{"limit_id":"codex"}'
       )`,
    )
    .run();
}

beforeEach(() => {
  testDb.instance = createTestDb();
  testDb.instance.sqlite
    .prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Project One')")
    .run();
  refreshMock.mockReset();
  refreshMock.mockImplementation(() => {});
  claudeCacheMock.mockReset().mockResolvedValue(NO_LIVE);
  codexCacheMock.mockReset().mockResolvedValue(NO_LIVE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/usage", () => {
  it("returns the report inside the { data } envelope", async () => {
    seedSession("s1");

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.data).toBeDefined();
    expect(body.data.totals).toEqual({
      sessions: 1,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 1.25,
    });
  });

  it("refreshes the codex snapshot before reading (refresh-on-read seam)", async () => {
    await GET(request());
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("serves every section of the contract in one response", async () => {
    seedSession("s1");

    const { data } = await (await GET(request())).json();

    expect(Object.keys(data).sort()).toEqual([
      "byAgent",
      "byDay",
      "byProject",
      "byProvider",
      "dashboard",
      "generatedAt",
      "subscriptions",
      "totals",
      "windows",
    ]);
    expect(data.byDay).toHaveLength(30);
    expect(data.byAgent[0].name).toBe("Builder");
    expect(data.byProject[0].projectName).toBe("Project One");
    expect(data.windows.last5h.sessions).toBe(1);
    expect(data.windows.last7d.sessions).toBe(1);
    expect(typeof data.generatedAt).toBe("string");
  });

  it("always ships the claude card labelled as metered when live quota is unavailable", async () => {
    const { data } = await (await GET(request())).json();
    const claude = data.subscriptions.find(
      (s: { provider: string }) => s.provider === "claude-code",
    );
    expect(claude.source).toBe("metered-via-arij");
    expect(claude.capturedAt).toBeNull();
    expect(claude.metered).not.toBeNull();
  });

  it("responds on an empty database without inventing numbers", async () => {
    const { data } = await (await GET(request())).json();
    expect(data.totals.sessions).toBe(0);
    expect(data.totals.costUsd).toBeNull();
    expect(data.byAgent).toEqual([]);
  });

  it("returns the { error } envelope with a 500 when the read blows up", async () => {
    refreshMock.mockImplementation(() => {
      throw new Error("boom");
    });

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("boom");
    expect(body.data).toBeUndefined();
  });
});

describe("GET /api/usage — quota cache wiring", () => {
  it("a plain GET respects the TTL (force = false on both providers)", async () => {
    await GET(request());
    expect(claudeCacheMock).toHaveBeenCalledTimes(1);
    expect(claudeCacheMock).toHaveBeenCalledWith(false);
    expect(codexCacheMock).toHaveBeenCalledTimes(1);
    expect(codexCacheMock).toHaveBeenCalledWith(false);
  });

  it("?fresh=1 bypasses the TTL (force = true on both providers)", async () => {
    await GET(request(true));
    expect(claudeCacheMock).toHaveBeenCalledWith(true);
    expect(codexCacheMock).toHaveBeenCalledWith(true);
  });

  it("any other fresh value is treated as a plain GET", async () => {
    await GET(new Request("http://localhost/api/usage?fresh=yes"));
    expect(claudeCacheMock).toHaveBeenCalledWith(false);
    expect(codexCacheMock).toHaveBeenCalledWith(false);
  });
});

describe("GET /api/usage — precedence matrix (live vs fallback x claude vs codex)", () => {
  it("[claude x live] provider-reported live-cli card with metered STILL populated", async () => {
    seedSession("s1");
    claudeCacheMock.mockResolvedValue({
      data: CLAUDE_LIVE,
      capturedAtIso: "2026-08-18T11:58:00.000Z",
    });

    const { data } = await (await GET(request())).json();
    const claude = data.subscriptions.find(
      (s: { provider: string }) => s.provider === "claude-code",
    );

    expect(claude.source).toBe("provider-reported");
    expect(claude.sourceDetail).toBe("live-cli");
    expect(claude.plan).toBe("max");
    expect(claude.capturedAt).toBe("2026-08-18T11:58:00.000Z");
    expect(claude.claudeLive).toEqual(CLAUDE_LIVE);
    expect(claude.codexLive).toBeNull();
    // Claude uses ISO resets — the unix-seconds window path stays null.
    expect(claude.primary).toBeNull();
    expect(claude.secondary).toBeNull();
    // Both truths ship; the UI demotes, never the API.
    expect(claude.metered).not.toBeNull();
    expect(claude.metered.last5h.sessions).toBe(1);
    expect(claude.metered.last5h.costUsd).toBe(1.25);
  });

  it("[claude x fallback] today's metered shape plus the three new keys", async () => {
    const { data } = await (await GET(request())).json();
    const claude = data.subscriptions.find(
      (s: { provider: string }) => s.provider === "claude-code",
    );

    expect(claude.source).toBe("metered-via-arij");
    expect(claude.sourceDetail).toBe("arij-sessions");
    expect(claude.claudeLive).toBeNull();
    expect(claude.codexLive).toBeNull();
    expect(claude.plan).toBeNull();
    expect(claude.capturedAt).toBeNull();
    expect(claude.metered).not.toBeNull();
  });

  it("[codex x live] card exists even with no snapshot row and no codex sessions", async () => {
    codexCacheMock.mockResolvedValue({
      data: CODEX_LIVE,
      capturedAtIso: "2026-08-18T11:58:00.000Z",
    });

    const { data } = await (await GET(request())).json();
    const codex = data.subscriptions.find(
      (s: { provider: string }) => s.provider === "codex",
    );

    expect(codex).toBeDefined();
    expect(codex.source).toBe("provider-reported");
    expect(codex.sourceDetail).toBe("live-cli");
    expect(codex.plan).toBe("prolite");
    expect(codex.capturedAt).toBe("2026-08-18T11:58:00.000Z");
    // primary mirrors the "codex" bucket so SnapshotWindow consumers cohere.
    expect(codex.primary).toEqual({
      usedPercent: 6,
      windowMinutes: 10080,
      resetsAt: 1787671089,
    });
    expect(codex.secondary).toBeNull();
    expect(codex.codexLive).toEqual(CODEX_LIVE);
    expect(codex.claudeLive).toBeNull();
    expect(codex.metered).toBeNull();
  });

  it("[codex x fallback] today's rollout-snapshot shape plus the three new keys", async () => {
    seedSnapshot();

    const { data } = await (await GET(request())).json();
    const codex = data.subscriptions.find(
      (s: { provider: string }) => s.provider === "codex",
    );

    expect(codex.source).toBe("provider-reported");
    expect(codex.sourceDetail).toBe("rollout-snapshot");
    expect(codex.plan).toBe("prolite");
    expect(codex.capturedAt).toBe("2026-08-18T09:00:00.000Z");
    expect(codex.primary).toEqual({
      usedPercent: 6,
      windowMinutes: 10080,
      resetsAt: 1787671089,
    });
    expect(codex.codexLive).toBeNull();
    expect(codex.claudeLive).toBeNull();
  });

  it("[codex x fallback] no snapshot and no codex sessions => no codex card at all", async () => {
    const { data } = await (await GET(request())).json();
    expect(
      data.subscriptions.map((s: { provider: string }) => s.provider),
    ).toEqual(["claude-code"]);
  });
});

describe("GET /api/usage — fallback invisibility proof", () => {
  it("pollers failing => the response deep-equals today's no-live report", async () => {
    // Freeze the clock so generatedAt (and the 30-day strip) are identical
    // between the route call and the direct legacy call.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    seedSession("s1", {
      endedAt: "2026-08-18T11:30:00.000Z",
      createdAt: "2026-08-18T11:00:00.000Z",
    });
    seedSnapshot();

    const { data } = await (await GET(request())).json();
    // getUsageReport() with no argument IS today's behavior (the live inputs
    // default to the no-live state). JSON round-trip mirrors serialization.
    const legacy = JSON.parse(JSON.stringify(getUsageReport()));

    expect(data).toEqual(legacy);
  });
});
