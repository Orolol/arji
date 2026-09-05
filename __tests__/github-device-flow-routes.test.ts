/**
 * Route-level tests for POST /api/auth/github/device/{start,poll}.
 *
 * The transport module (`lib/github/device-flow.ts`) has its own suite; this
 * file covers what the ROUTES add on top of it: the opaque handle, the
 * server-side custody of the device code, the single-flow slot, the mapping
 * from poll states onto HTTP statuses, and the settings write.
 *
 * The single assertion this whole epic rests on has its own describe block at
 * the bottom: neither the device code nor the access token may cross the wire
 * or reach a log.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockNextRequest,
} from "@/__tests__/helpers/db-mock";
import { _resetDeviceFlowStoreForTests } from "@/lib/github/device-flow-store";
import type { DeviceFlowStart } from "@/lib/github/device-flow";

const mockStartDeviceFlow = vi.hoisted(() => vi.fn());
const mockPollDeviceFlow = vi.hoisted(() => vi.fn());
const mockValidateGitHubToken = vi.hoisted(() => vi.fn());

// Real module apart from the two network calls: DeviceFlowError, the
// constants and the store's own imports must stay real, or the routes would
// be tested against a fake error class they never actually catch.
vi.mock("@/lib/github/device-flow", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github/device-flow")>(
    "@/lib/github/device-flow"
  );
  return {
    ...actual,
    startDeviceFlow: mockStartDeviceFlow,
    pollDeviceFlow: mockPollDeviceFlow,
  };
});

vi.mock("@/lib/github/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github/client")>(
    "@/lib/github/client"
  );
  return { ...actual, validateGitHubToken: mockValidateGitHubToken };
});

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

const DEVICE_CODE = "dc_secret_device_code_value";
const ACCESS_TOKEN = "gho_live_access_token_value";

function githubStart(overrides: Partial<DeviceFlowStart> = {}): DeviceFlowStart {
  return {
    deviceCode: DEVICE_CODE,
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
    ...overrides,
  };
}

async function startFlow(): Promise<{ handle: string; json: Record<string, never> }> {
  const { POST } = await import("@/app/api/auth/github/device/start/route");
  const res = await POST(mockNextRequest({ method: "POST" }));
  const json = await res.json();
  return { handle: json.data.handle, json };
}

async function poll(handle: string) {
  const { POST } = await import("@/app/api/auth/github/device/poll/route");
  const res = await POST(mockJsonRequest({ handle }));
  return { res, json: await res.json() };
}

describe("POST /api/auth/github/device/start", () => {
  beforeEach(() => {
    // mockReset, not just clearAllMocks: an unconsumed `mockResolvedValueOnce`
    // survives a clear and would answer the FIRST poll of the next test.
    mockStartDeviceFlow.mockReset();
    mockPollDeviceFlow.mockReset();
    mockValidateGitHubToken.mockReset();
    vi.clearAllMocks();
    resetDbMockState();
    _resetDeviceFlowStoreForTests();
    mockStartDeviceFlow.mockResolvedValue(githubStart());
  });

  it("returns the displayable half of the pair and never the device code", async () => {
    const { POST } = await import("@/app/api/auth/github/device/start/route");
    const res = await POST(mockNextRequest({ method: "POST" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.userCode).toBe("WDJB-MJHT");
    expect(json.data.verificationUri).toBe("https://github.com/login/device");
    expect(json.data.interval).toBe(5);
    expect(typeof json.data.handle).toBe("string");
    expect(json.data.handle.length).toBeGreaterThan(8);
    expect(json.data.deviceCode).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain(DEVICE_CODE);
  });

  it("accepts a POST with no body at all", async () => {
    const { POST } = await import("@/app/api/auth/github/device/start/route");
    const res = await POST(mockNextRequest({ method: "POST" }));

    expect(res.status).toBe(200);
    expect(mockStartDeviceFlow).toHaveBeenCalledTimes(1);
  });

  it("rejects a body that is present but malformed", async () => {
    const { POST } = await import("@/app/api/auth/github/device/start/route");
    const res = await POST(
      mockNextRequest({ method: "POST", body: "{not json" })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Invalid JSON body");
    expect(mockStartDeviceFlow).not.toHaveBeenCalled();
  });

  it("does not let a client choose the scopes", async () => {
    const { POST } = await import("@/app/api/auth/github/device/start/route");
    await POST(mockJsonRequest({ scopes: "admin:org delete_repo" }));

    // Called with no argument: the route uses the module's fixed scopes.
    expect(mockStartDeviceFlow).toHaveBeenCalledWith();
  });

  it("answers 400 with a code when the OAuth App client ID is not configured", async () => {
    const { DeviceFlowError } = await vi.importActual<
      typeof import("@/lib/github/device-flow")
    >("@/lib/github/device-flow");
    mockStartDeviceFlow.mockRejectedValue(
      new DeviceFlowError(
        "CLIENT_ID_NOT_CONFIGURED",
        "The Arij GitHub OAuth App is not configured yet."
      )
    );

    const { POST } = await import("@/app/api/auth/github/device/start/route");
    const res = await POST(mockNextRequest({ method: "POST" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("CLIENT_ID_NOT_CONFIGURED");
    expect(json.error).toContain("not configured");
    expect(json.data).toBeUndefined();
  });

  it("answers 503 when GitHub cannot be reached", async () => {
    const { DeviceFlowError } = await vi.importActual<
      typeof import("@/lib/github/device-flow")
    >("@/lib/github/device-flow");
    mockStartDeviceFlow.mockRejectedValue(
      new DeviceFlowError("GITHUB_UNREACHABLE", "Could not reach GitHub.")
    );

    const { POST } = await import("@/app/api/auth/github/device/start/route");
    const res = await POST(mockNextRequest({ method: "POST" }));
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.code).toBe("GITHUB_UNREACHABLE");
  });

  it("answers 500 with a code for an unexpected throw", async () => {
    mockStartDeviceFlow.mockRejectedValue(new TypeError("boom"));

    const { POST } = await import("@/app/api/auth/github/device/start/route");
    const res = await POST(mockNextRequest({ method: "POST" }));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.code).toBe("DEVICE_FLOW_START_FAILED");
    // The internal message is not the user's problem and not their error text.
    expect(json.error).not.toContain("boom");
  });

  it("caps a flow's lifetime at fifteen minutes whatever GitHub reports", async () => {
    mockStartDeviceFlow.mockResolvedValue(githubStart({ expiresIn: 7200 }));

    const { POST } = await import("@/app/api/auth/github/device/start/route");
    const json = await (await POST(mockNextRequest({ method: "POST" }))).json();

    expect(json.data.expiresIn).toBeLessThanOrEqual(900);
    expect(json.data.expiresIn).toBeGreaterThan(890);
  });

  it("supersedes an earlier flow, so the old handle stops resolving", async () => {
    const first = await startFlow();
    const second = await startFlow();

    expect(second.handle).not.toBe(first.handle);

    const stale = await poll(first.handle);
    expect(stale.res.status).toBe(404);
    expect(stale.json.code).toBe("DEVICE_FLOW_NOT_FOUND");
    expect(mockPollDeviceFlow).not.toHaveBeenCalled();

    mockPollDeviceFlow.mockResolvedValue({ state: "pending" });
    const live = await poll(second.handle);
    expect(live.res.status).toBe(200);
  });
});

describe("POST /api/auth/github/device/poll", () => {
  beforeEach(() => {
    // mockReset, not just clearAllMocks: an unconsumed `mockResolvedValueOnce`
    // survives a clear and would answer the FIRST poll of the next test.
    mockStartDeviceFlow.mockReset();
    mockPollDeviceFlow.mockReset();
    mockValidateGitHubToken.mockReset();
    vi.clearAllMocks();
    resetDbMockState();
    _resetDeviceFlowStoreForTests();
    mockStartDeviceFlow.mockResolvedValue(githubStart());
    mockValidateGitHubToken.mockResolvedValue({ valid: true, login: "octocat" });
  });

  it("rejects a missing handle in zod before touching GitHub", async () => {
    const { POST } = await import("@/app/api/auth/github/device/poll/route");
    const res = await POST(mockJsonRequest({}));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Validation failed");
    expect(json.details.handle).toBeDefined();
    expect(mockPollDeviceFlow).not.toHaveBeenCalled();
  });

  it("rejects a blank handle", async () => {
    const { POST } = await import("@/app/api/auth/github/device/poll/route");
    const res = await POST(mockJsonRequest({ handle: "" }));

    expect(res.status).toBe(400);
    expect(mockPollDeviceFlow).not.toHaveBeenCalled();
  });

  it("answers 404 for a handle no flow was ever minted for", async () => {
    const { res, json } = await poll("gh-device-nonexistent");

    expect(res.status).toBe(404);
    expect(json.code).toBe("DEVICE_FLOW_NOT_FOUND");
    expect(json.data).toBeUndefined();
  });

  it("answers 410 once a flow has outlived its deadline, then 404", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { handle } = await startFlow();
      vi.setSystemTime(Date.now() + 16 * 60 * 1000);

      const expired = await poll(handle);
      expect(expired.res.status).toBe(410);
      expect(expired.json.code).toBe("DEVICE_FLOW_EXPIRED");
      expect(mockPollDeviceFlow).not.toHaveBeenCalled();

      // The expired record is dropped as it is read, so the client is not
      // handed a 410 from a corpse forever.
      const again = await poll(handle);
      expect(again.res.status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports pending with the cadence to wait", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({ state: "pending" });

    const { res, json } = await poll(handle);

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ state: "pending", interval: 5 });
    expect(mockPollDeviceFlow).toHaveBeenCalledWith(DEVICE_CODE, 5);
  });

  it("persists a slow_down so the next tick is measured against the new cadence", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce({ state: "slow_down", interval: 12 });

    const first = await poll(handle);
    expect(first.res.status).toBe(200);
    expect(first.json.data).toEqual({ state: "slow_down", interval: 12 });

    mockPollDeviceFlow.mockResolvedValueOnce({ state: "pending" });
    const second = await poll(handle);

    expect(mockPollDeviceFlow).toHaveBeenLastCalledWith(DEVICE_CODE, 12);
    expect(second.json.data).toEqual({ state: "pending", interval: 12 });
  });

  it("answers 410 and drops the flow when GitHub says the code expired", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({ state: "expired" });

    const { res, json } = await poll(handle);
    expect(res.status).toBe(410);
    expect(json.code).toBe("DEVICE_FLOW_EXPIRED");

    expect((await poll(handle)).res.status).toBe(404);
  });

  it("answers 403 and drops the flow when the user refuses on github.com", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({ state: "denied" });

    const { res, json } = await poll(handle);
    expect(res.status).toBe(403);
    expect(json.code).toBe("DEVICE_FLOW_DENIED");

    expect((await poll(handle)).res.status).toBe(404);
  });

  it("keeps the flow alive through a network blip", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "error",
      code: "github_unreachable",
      message: "Could not reach GitHub.",
    });

    const blip = await poll(handle);
    expect(blip.res.status).toBe(503);
    expect(blip.json.code).toBe("GITHUB_UNREACHABLE");

    // The device code is good for another fourteen minutes; a dropped packet
    // must not force the user to start over.
    mockPollDeviceFlow.mockResolvedValueOnce({ state: "pending" });
    const recovered = await poll(handle);
    expect(recovered.res.status).toBe(200);
    expect(recovered.json.data.state).toBe("pending");
  });

  it("drops the flow when GitHub refuses it outright", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({
      state: "error",
      code: "incorrect_device_code",
      message: "GitHub did not recognise this sign-in.",
    });

    const { res, json } = await poll(handle);
    expect(res.status).toBe(502);
    expect(json.code).toBe("INCORRECT_DEVICE_CODE");

    expect((await poll(handle)).res.status).toBe(404);
  });

  it("stores the token and its provenance in one transaction on success", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo", "read:user"],
    });

    const { res, json } = await poll(handle);

    expect(res.status).toBe(200);
    expect(json.data.state).toBe("success");
    expect(json.data.login).toBe("octocat");
    expect(json.data.scopes).toEqual(["repo", "read:user"]);
    expect(json.data.tokenSource).toBe("oauth_device");
    expect(Number.isNaN(Date.parse(json.data.obtainedAt))).toBe(false);

    expect(mockValidateGitHubToken).toHaveBeenCalledWith(ACCESS_TOKEN);

    const written = dbMockState.insertCalls as Array<{ key: string; value: string }>;
    const pat = written.find((row) => row.key === "github_pat");
    const meta = written.find((row) => row.key === "github_oauth_meta");

    expect(pat?.value).toBe(JSON.stringify(ACCESS_TOKEN));
    expect(JSON.parse(meta?.value ?? "null")).toEqual({
      login: "octocat",
      scopes: ["repo", "read:user"],
      obtainedAt: json.data.obtainedAt,
      tokenSource: "oauth_device",
    });

    // The flow is spent.
    expect((await poll(handle)).res.status).toBe(404);
  });

  it("stores nothing when GitHub will not authenticate the token it just issued", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });
    mockValidateGitHubToken.mockResolvedValue({
      valid: false,
      error: "GitHub rejected the token. Verify it and try again.",
      status: 401,
    });

    const { res, json } = await poll(handle);

    expect(res.status).toBe(502);
    expect(json.code).toBe("TOKEN_VALIDATION_FAILED");
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("stores nothing when the token cannot be attributed to an account", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });
    mockValidateGitHubToken.mockResolvedValue({ valid: true, login: "  " });

    const { res, json } = await poll(handle);

    expect(res.status).toBe(502);
    expect(json.code).toBe("TOKEN_VALIDATION_FAILED");
    expect(dbMockState.insertCalls).toHaveLength(0);
  });
});

describe("the token and the device code stay on the server", () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    // mockReset, not just clearAllMocks: an unconsumed `mockResolvedValueOnce`
    // survives a clear and would answer the FIRST poll of the next test.
    mockStartDeviceFlow.mockReset();
    mockPollDeviceFlow.mockReset();
    mockValidateGitHubToken.mockReset();
    vi.clearAllMocks();
    resetDbMockState();
    _resetDeviceFlowStoreForTests();
    mockStartDeviceFlow.mockResolvedValue(githubStart());
    mockValidateGitHubToken.mockResolvedValue({ valid: true, login: "octocat" });
    consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => {})
    );
  });

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore();
  });

  function loggedText(): string {
    return consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => {
        try {
          return typeof arg === "string" ? arg : JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join("\n");
  }

  it("leaks neither secret across a full start → pending → success run", async () => {
    const startRes = await (
      await import("@/app/api/auth/github/device/start/route")
    ).POST(mockNextRequest({ method: "POST" }));
    const startBody = await startRes.text();

    const handle = JSON.parse(startBody).data.handle;

    mockPollDeviceFlow.mockResolvedValueOnce({ state: "pending" });
    const { POST } = await import("@/app/api/auth/github/device/poll/route");
    const pendingBody = await (
      await POST(mockJsonRequest({ handle }))
    ).text();

    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo", "read:user"],
    });
    const successBody = await (
      await POST(mockJsonRequest({ handle }))
    ).text();

    const overTheWire = [startBody, pendingBody, successBody].join("\n");

    expect(overTheWire).not.toContain(ACCESS_TOKEN);
    expect(overTheWire).not.toContain(DEVICE_CODE);
    expect(loggedText()).not.toContain(ACCESS_TOKEN);
    expect(loggedText()).not.toContain(DEVICE_CODE);

    // The run really did reach the end — otherwise the assertions above pass
    // for the wrong reason.
    expect(JSON.parse(successBody).data.state).toBe("success");
  });

  it("keeps both secrets out of the failure paths too", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({
      state: "error",
      code: "incorrect_device_code",
      message: "GitHub did not recognise this sign-in.",
    });

    const { POST } = await import("@/app/api/auth/github/device/poll/route");
    const body = await (await POST(mockJsonRequest({ handle }))).text();

    expect(body).not.toContain(DEVICE_CODE);
    expect(body).not.toContain(ACCESS_TOKEN);
    expect(loggedText()).not.toContain(DEVICE_CODE);
  });
});

describe("what GET /api/settings shows after a device-flow connection", () => {
  beforeEach(() => {
    // mockReset, not just clearAllMocks: an unconsumed `mockResolvedValueOnce`
    // survives a clear and would answer the FIRST poll of the next test.
    mockStartDeviceFlow.mockReset();
    mockPollDeviceFlow.mockReset();
    mockValidateGitHubToken.mockReset();
    vi.clearAllMocks();
    resetDbMockState();
    _resetDeviceFlowStoreForTests();
    mockStartDeviceFlow.mockResolvedValue(githubStart());
    mockValidateGitHubToken.mockResolvedValue({ valid: true, login: "octocat" });
  });

  it("masks the token and serves the connection metadata in the clear", async () => {
    const { handle } = await startFlow();
    mockPollDeviceFlow.mockResolvedValue({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo", "read:user"],
    });
    await poll(handle);

    // Replay the rows the poll route actually wrote, rather than a hand-built
    // fixture — a fixture would keep passing if the write shape drifted.
    dbMockState.allRows = (
      dbMockState.insertCalls as Array<{ key: string; value: string }>
    ).map((row) => ({ key: row.key, value: row.value }));

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.github_pat).toEqual({ hasToken: true });
    expect(json.data.github_oauth_meta).toEqual({
      login: "octocat",
      scopes: ["repo", "read:user"],
      obtainedAt: expect.any(String),
      tokenSource: "oauth_device",
    });
    expect(JSON.stringify(json)).not.toContain(ACCESS_TOKEN);
  });
});

describe("PATCH /api/settings github_oauth_meta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("accepts a well-formed connection record", async () => {
    dbMockState.getQueue = [null];
    const { PATCH } = await import("@/app/api/settings/route");

    const meta = {
      login: "octocat",
      scopes: ["repo", "read:user"],
      obtainedAt: "2026-09-05T10:00:00.000Z",
      tokenSource: "manual",
    };
    const res = await PATCH(mockJsonRequest({ github_oauth_meta: meta }));

    expect(res.status).toBe(200);
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        key: "github_oauth_meta",
        value: JSON.stringify(meta),
      })
    );
  });

  it("accepts null, which is how a connection is cleared", async () => {
    dbMockState.getQueue = [null];
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(mockJsonRequest({ github_oauth_meta: null }));

    expect(res.status).toBe(200);
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({ key: "github_oauth_meta", value: "null" })
    );
  });

  it.each([
    ["a bare string", "octocat"],
    ["an unknown token source", { login: "octocat", scopes: [], obtainedAt: "2026-09-05T10:00:00.000Z", tokenSource: "telepathy" }],
    ["a missing login", { scopes: [], obtainedAt: "2026-09-05T10:00:00.000Z", tokenSource: "manual" }],
    ["scopes that are not a list", { login: "octocat", scopes: "repo", obtainedAt: "2026-09-05T10:00:00.000Z", tokenSource: "manual" }],
    ["an unparseable timestamp", { login: "octocat", scopes: [], obtainedAt: "whenever", tokenSource: "manual" }],
  ])("rejects %s", async (_label, value) => {
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(mockJsonRequest({ github_oauth_meta: value }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("GitHub connection metadata");
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("writes nothing at all when one key in a multi-key payload is invalid", async () => {
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(
      mockJsonRequest({
        global_prompt: "Always write tests",
        github_oauth_meta: "not-an-object",
      })
    );

    expect(res.status).toBe(400);
    expect(dbMockState.insertCalls).toHaveLength(0);
    expect(dbMockState.updateCalls).toHaveLength(0);
  });
});
