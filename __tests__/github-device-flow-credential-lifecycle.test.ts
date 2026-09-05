/**
 * The device flow's credential lifecycle: who is allowed to write the token,
 * and when.
 *
 * A poll tick spends two awaits between reading the flow and writing to
 * `settings` — GitHub's token endpoint, then the identity lookup. The slot can
 * change under either one, and every way it can change is a user decision:
 * they clicked the button again, they cancelled, they gave up and pasted a PAT
 * by hand, they disconnected. A tick that wrote regardless would overrule the
 * decision the user made LAST, minutes after they made it, and the browser
 * would show nothing — the hook's own generation guard drops the answer.
 *
 * So every case below is the same shape: hold a poll open with a deferred
 * promise, change the world underneath it, let it finish, and assert that
 * nothing reached the database.
 *
 * The sibling concern is the write itself failing. A consumed authorization
 * cannot be replayed, so the flow has to settle rather than look retryable,
 * and the error must not carry the token — the failing statement's parameters
 * contain it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  getDbChainMock,
  resetDbMockState,
  mockJsonRequest,
  mockNextRequest,
} from "@/__tests__/helpers/db-mock";
import {
  abortDeviceFlow,
  beginDeviceFlowPoll,
  claimDeviceFlow,
  endDeviceFlowPoll,
  rememberDeviceFlow,
  resolveDeviceFlow,
  _resetDeviceFlowStoreForTests,
} from "@/lib/github/device-flow-store";
import type { DeviceFlowStart } from "@/lib/github/device-flow";

const mockStartDeviceFlow = vi.hoisted(() => vi.fn());
const mockPollDeviceFlow = vi.hoisted(() => vi.fn());
const mockValidateGitHubToken = vi.hoisted(() => vi.fn());

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
const MANUAL_PAT = "ghp_pasted_by_hand_value";

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

/** A promise the test resolves by hand, to hold a route mid-await. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Let a pending route advance to its next await before changing the world.
 *
 * A macrotask, so it lands after every microtask the route is sitting on —
 * including the module cache lookup its own `await import(...)` does.
 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Load every route once up front.
 *
 * The helpers below `await import(...)` on each call, which is instant for a
 * cached module and several ticks for a cold one. Without this, the first race
 * in the file would be won by whichever route happened to be loading — the
 * test would assert a real interleaving and observe a module resolution.
 */
beforeAll(async () => {
  await Promise.all([
    import("@/app/api/auth/github/device/start/route"),
    import("@/app/api/auth/github/device/poll/route"),
    import("@/app/api/auth/github/device/cancel/route"),
    import("@/app/api/settings/route"),
  ]);
});

async function startFlow(): Promise<string> {
  const { POST } = await import("@/app/api/auth/github/device/start/route");
  const res = await POST(mockNextRequest({ method: "POST" }));
  return (await res.json()).data.handle;
}

async function poll(handle: string) {
  const { POST } = await import("@/app/api/auth/github/device/poll/route");
  const res = await POST(mockJsonRequest({ handle }));
  return { res, json: await res.json() };
}

async function cancel(handle: string) {
  const { POST } = await import("@/app/api/auth/github/device/cancel/route");
  const res = await POST(mockJsonRequest({ handle }));
  return { res, json: await res.json() };
}

async function patchSettings(body: Record<string, unknown>) {
  const { PATCH } = await import("@/app/api/settings/route");
  // One queued `null` per key: PATCH looks each row up before deciding
  // insert-or-update, and the mock's get() queue is what answers.
  dbMockState.getQueue.push(...Object.keys(body).map(() => null));
  return PATCH(mockJsonRequest(body));
}

/** Every `github_pat` value the routes wrote, in order. */
function writtenTokens(): string[] {
  return [
    ...(dbMockState.insertCalls as Array<{ key?: string; value?: string }>),
    ...(dbMockState.updateCalls as Array<{ key?: string; value?: string }>),
  ]
    .filter((row) => typeof row.value === "string")
    .map((row) => row.value as string);
}

function resetAll(): void {
  mockStartDeviceFlow.mockReset();
  mockPollDeviceFlow.mockReset();
  mockValidateGitHubToken.mockReset();
  vi.clearAllMocks();
  resetDbMockState();
  _resetDeviceFlowStoreForTests();
  mockStartDeviceFlow.mockResolvedValue(githubStart());
  mockValidateGitHubToken.mockResolvedValue({ valid: true, login: "octocat" });
}

/* ------------------------------------------------------------------ */

describe("a flow that lost the slot cannot write a token", () => {
  beforeEach(resetAll);

  it("refuses when a newer start replaced it WHILE it was polling GitHub", async () => {
    const first = await startFlow();

    const github = deferred<unknown>();
    mockPollDeviceFlow.mockReturnValueOnce(github.promise);
    const pending = poll(first);
    await flush();

    // The user gave up waiting and clicked the button again.
    mockStartDeviceFlow.mockResolvedValueOnce(
      githubStart({ deviceCode: "dc_second_flow", userCode: "ABCD-1234" })
    );
    const second = await startFlow();
    expect(second).not.toBe(first);

    // ...and only now does the first flow's authorization come back.
    github.resolve({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo", "read:user"],
    });
    const { res, json } = await pending;

    expect(res.status).toBe(409);
    expect(json.code).toBe("DEVICE_FLOW_SUPERSEDED");
    expect(writtenTokens()).toHaveLength(0);
    expect(JSON.stringify(json)).not.toContain(ACCESS_TOKEN);

    // The flow the user is actually watching is untouched by any of it.
    mockPollDeviceFlow.mockResolvedValueOnce({ state: "pending" });
    const live = await poll(second);
    expect(live.res.status).toBe(200);
    expect(live.json.data.state).toBe("pending");
  });

  it("refuses when a newer start replaced it WHILE it was validating the identity", async () => {
    const first = await startFlow();

    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });
    const identity = deferred<unknown>();
    mockValidateGitHubToken.mockReturnValueOnce(identity.promise);

    const pending = poll(first);
    await flush();

    mockStartDeviceFlow.mockResolvedValueOnce(
      githubStart({ deviceCode: "dc_second_flow" })
    );
    await startFlow();

    identity.resolve({ valid: true, login: "octocat" });
    const { res, json } = await pending;

    expect(res.status).toBe(409);
    expect(json.code).toBe("DEVICE_FLOW_SUPERSEDED");
    expect(writtenTokens()).toHaveLength(0);
  });

  it("refuses after the user cancelled, even though GitHub said yes", async () => {
    const handle = await startFlow();

    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });
    const identity = deferred<unknown>();
    mockValidateGitHubToken.mockReturnValueOnce(identity.promise);

    const pending = poll(handle);
    await flush();

    const cancelled = await cancel(handle);
    expect(cancelled.res.status).toBe(200);

    identity.resolve({ valid: true, login: "octocat" });
    const { res, json } = await pending;

    expect(res.status).toBe(409);
    expect(json.code).toBe("DEVICE_FLOW_SUPERSEDED");
    expect(writtenTokens()).toHaveLength(0);
  });

  it("does not overwrite a PAT the user pasted while it was in flight", async () => {
    const handle = await startFlow();

    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });
    const identity = deferred<unknown>();
    mockValidateGitHubToken.mockReturnValueOnce(identity.promise);

    const pending = poll(handle);
    await flush();

    // The fallback field, one line below the button, used while the OAuth
    // screen was still open.
    const patched = await patchSettings({ github_pat: MANUAL_PAT });
    expect(patched.status).toBe(200);

    identity.resolve({ valid: true, login: "octocat" });
    const { res } = await pending;

    expect(res.status).toBe(409);
    const tokens = writtenTokens();
    expect(tokens).toContain(JSON.stringify(MANUAL_PAT));
    expect(tokens.join("|")).not.toContain(ACCESS_TOKEN);
  });

  it("does not reconnect an account the user just disconnected", async () => {
    const handle = await startFlow();

    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });
    const identity = deferred<unknown>();
    mockValidateGitHubToken.mockReturnValueOnce(identity.promise);

    const pending = poll(handle);
    await flush();

    // What "Déconnecter" sends: both keys cleared in one PATCH.
    const patched = await patchSettings({
      github_pat: "",
      github_oauth_meta: null,
    });
    expect(patched.status).toBe(200);

    identity.resolve({ valid: true, login: "octocat" });
    const { res } = await pending;

    expect(res.status).toBe(409);
    expect(writtenTokens().join("|")).not.toContain(ACCESS_TOKEN);
  });

  it("leaves a PATCH that touches no GitHub key alone", async () => {
    const handle = await startFlow();

    await patchSettings({ global_prompt: "Always write tests" });

    // Unrelated settings are not a statement about credentials, so the flow
    // the user is halfway through must survive them.
    expect(resolveDeviceFlow(handle).state).toBe("active");
  });
});

describe("a poll that cannot be written settles instead of looking retryable", () => {
  beforeEach(resetAll);

  it("answers 500 with a code, and never quotes the failing statement", async () => {
    const handle = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });

    // Shaped like the real thing: better-sqlite3 puts the bound parameters in
    // the message, so the token is inside the error we must not echo.
    getDbChainMock().transaction.mockImplementationOnce(() => {
      throw new Error(
        `SQLITE_READONLY: attempt to write a readonly database — params: ["${ACCESS_TOKEN}"]`
      );
    });

    const { res, json } = await poll(handle);

    expect(res.status).toBe(500);
    expect(json.code).toBe("DEVICE_FLOW_PERSIST_FAILED");
    expect(json.data).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain(ACCESS_TOKEN);
    expect(json.error).not.toContain("SQLITE_READONLY");
    // It points at the fallback rather than at a retry that cannot work.
    expect(json.error).toContain("token");
  });

  it("settles the flow, so the spent authorization stops looking usable", async () => {
    const handle = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });
    getDbChainMock().transaction.mockImplementationOnce(() => {
      throw new Error("SQLITE_READONLY");
    });

    await poll(handle);

    // The device code was exchanged; polling it again would only ever 502.
    const again = await poll(handle);
    expect(again.res.status).toBe(404);
    expect(again.json.code).toBe("DEVICE_FLOW_NOT_FOUND");
    expect(mockPollDeviceFlow).toHaveBeenCalledTimes(1);
  });
});

describe("two ticks in flight at once", () => {
  beforeEach(resetAll);

  it("sends only one to GitHub and tells the other to keep waiting", async () => {
    const handle = await startFlow();

    const github = deferred<unknown>();
    mockPollDeviceFlow.mockReturnValueOnce(github.promise);
    const first = poll(handle);
    await flush();

    const second = await poll(handle);

    // A device code buys exactly one exchange; the duplicate must not spend it.
    expect(mockPollDeviceFlow).toHaveBeenCalledTimes(1);
    expect(second.res.status).toBe(200);
    expect(second.json.data.state).toBe("pending");

    github.resolve({ state: "pending" });
    expect((await first).res.status).toBe(200);
  });

  it("keeps the duplicate out for the WHOLE tick, identity lookup included", async () => {
    const handle = await startFlow();

    mockPollDeviceFlow.mockResolvedValueOnce({
      state: "success",
      accessToken: ACCESS_TOKEN,
      scopes: ["repo"],
    });
    const identity = deferred<unknown>();
    mockValidateGitHubToken.mockReturnValueOnce(identity.promise);

    const first = poll(handle);
    await flush();

    // The duplicate arrives AFTER GitHub answered but BEFORE the identity
    // lookup came back. The device code is spent by now, so letting this tick
    // through would earn a terminal refusal from GitHub and drop the flow —
    // which would cost the first tick, holding a perfectly good token, its
    // claim. A successful sign-in would be discarded as "superseded".
    const second = await poll(handle);
    expect(mockPollDeviceFlow).toHaveBeenCalledTimes(1);
    expect(second.res.status).toBe(200);
    expect(second.json.data.state).toBe("pending");

    identity.resolve({ valid: true, login: "octocat" });
    const { res, json } = await first;

    // The sign-in the user actually completed still lands.
    expect(res.status).toBe(200);
    expect(json.data.state).toBe("success");
    expect(json.data.login).toBe("octocat");
    expect(writtenTokens()).toContain(JSON.stringify(ACCESS_TOKEN));
  });

  it("releases the marker so the next tick still reaches GitHub", async () => {
    const handle = await startFlow();

    const github = deferred<unknown>();
    mockPollDeviceFlow.mockReturnValueOnce(github.promise);
    const first = poll(handle);
    await flush();
    github.resolve({ state: "pending" });
    await first;

    mockPollDeviceFlow.mockResolvedValueOnce({ state: "pending" });
    await poll(handle);

    expect(mockPollDeviceFlow).toHaveBeenCalledTimes(2);
  });

  it("releases the marker even when the transport rejects outright", async () => {
    const handle = await startFlow();

    // `pollDeviceFlow` is contractually throw-free, so this is the `finally`
    // being pinned rather than a state the transport can actually produce: a
    // future bug there must not wedge the flow into permanent "pending".
    mockPollDeviceFlow.mockRejectedValueOnce(new TypeError("boom"));
    await expect(poll(handle)).rejects.toThrow("boom");

    mockPollDeviceFlow.mockResolvedValueOnce({ state: "pending" });
    const next = await poll(handle);

    expect(next.res.status).toBe(200);
    expect(next.json.data.state).toBe("pending");
  });
});

describe("POST /api/auth/github/device/cancel", () => {
  beforeEach(resetAll);

  it("drops the flow, so its handle stops resolving", async () => {
    const handle = await startFlow();

    const { res, json } = await cancel(handle);

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ cancelled: true });
    expect((await poll(handle)).res.status).toBe(404);
    expect(mockPollDeviceFlow).not.toHaveBeenCalled();
  });

  it("is idempotent, and unknown handles are not an error", async () => {
    expect((await cancel("gh-device-never-existed")).res.status).toBe(200);

    const handle = await startFlow();
    expect((await cancel(handle)).res.status).toBe(200);
    expect((await cancel(handle)).res.status).toBe(200);
  });

  it("is handle-scoped: a stale tab cannot kill the live sign-in", async () => {
    const live = await startFlow();

    await cancel("gh-device-some-older-handle");

    expect(resolveDeviceFlow(live).state).toBe("active");
  });

  it("rejects a body with no handle", async () => {
    const { POST } = await import("@/app/api/auth/github/device/cancel/route");
    const res = await POST(mockJsonRequest({}));

    expect(res.status).toBe(400);
  });
});

describe("the store primitives the guard is built from", () => {
  beforeEach(resetAll);

  it("claims exactly once, and consumes the slot doing it", () => {
    const record = rememberDeviceFlow(githubStart());

    expect(claimDeviceFlow(record.handle)).toBe(true);
    expect(claimDeviceFlow(record.handle)).toBe(false);
    expect(resolveDeviceFlow(record.handle).state).toBe("unknown");
  });

  it("refuses a claim from a handle that no longer owns the slot", () => {
    const first = rememberDeviceFlow(githubStart());
    rememberDeviceFlow(githubStart({ deviceCode: "dc_second" }));

    expect(claimDeviceFlow(first.handle)).toBe(false);
  });

  it("abortDeviceFlow reports whether there was anything to drop", () => {
    expect(abortDeviceFlow()).toBe(false);

    const record = rememberDeviceFlow(githubStart());
    expect(abortDeviceFlow()).toBe(true);
    expect(resolveDeviceFlow(record.handle).state).toBe("unknown");
  });

  it("the in-flight marker is per handle and does not leak across flows", () => {
    const first = rememberDeviceFlow(githubStart());
    expect(beginDeviceFlowPoll(first.handle)).toBe(true);
    expect(beginDeviceFlowPoll(first.handle)).toBe(false);

    const second = rememberDeviceFlow(githubStart({ deviceCode: "dc_second" }));
    // Releasing the superseded flow must not unlock the one that replaced it.
    endDeviceFlowPoll(first.handle);
    expect(beginDeviceFlowPoll(second.handle)).toBe(true);
    expect(beginDeviceFlowPoll(second.handle)).toBe(false);
  });
});
