/**
 * The two Device Flow routes driven through the REAL transport, with GitHub
 * mocked at `fetch`.
 *
 * `github-device-flow-routes.test.ts` mocks `startDeviceFlow`/`pollDeviceFlow`
 * so it can test what the routes add on top of them. That leaves one seam
 * unproven: the routes and the transport are only ever checked against a mock
 * the test file itself defines, so a contract both sides agree on wrongly —
 * an argument passed in the wrong order, a returned field read under the wrong
 * name, an interval that never reaches the response — passes there.
 *
 * This file closes that seam. Only `fetch` (GitHub's two OAuth endpoints),
 * `validateGitHubToken` (Octokit, not fetch, and covered by
 * `github-client.test.ts`) and the DB are faked; the transport, the store and
 * the routes are the real ones.
 *
 * Nothing here touches the network — every `fetch` is the mock below — or the
 * real database: `@/lib/db` is the shared mock helper.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
  mockNextRequest,
} from "@/__tests__/helpers/db-mock";
import { _resetDeviceFlowStoreForTests } from "@/lib/github/device-flow-store";
import {
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_OAUTH_CLIENT_ID_ENV_VAR,
} from "@/lib/github/device-flow";

const mockValidateGitHubToken = vi.hoisted(() => vi.fn());

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

const TEST_CLIENT_ID = "Iv1.test0client0id";
const DEVICE_CODE = "dc_secret_device_code_value";
const ACCESS_TOKEN = "gho_live_access_token_value";
const USER_CODE = "WDJB-MJHT";

const realFetch = global.fetch;

/** GitHub's answers, keyed by endpoint. Token answers are consumed in order. */
let deviceCodeBody: Record<string, unknown>;
let tokenBodies: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => {
    const target = String(url);
    const body =
      target === GITHUB_DEVICE_CODE_URL
        ? deviceCodeBody
        : (tokenBodies.shift() ?? { error: "authorization_pending" });

    if (target !== GITHUB_DEVICE_CODE_URL && target !== GITHUB_ACCESS_TOKEN_URL) {
      throw new Error(`Unexpected request to ${target}`);
    }

    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

/** The form body of the nth recorded request. */
function sentParams(callIndex: number): URLSearchParams {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return new URLSearchParams(String(init?.body ?? ""));
}

async function startFlow() {
  const { POST } = await import("@/app/api/auth/github/device/start/route");
  const res = await POST(mockNextRequest({ method: "POST" }));
  const json = await res.json();
  return { res, json, handle: json.data?.handle as string };
}

async function poll(handle: string) {
  const { POST } = await import("@/app/api/auth/github/device/poll/route");
  const res = await POST(mockJsonRequest({ handle }));
  return { res, json: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMockState();
  _resetDeviceFlowStoreForTests();
  vi.stubEnv(GITHUB_OAUTH_CLIENT_ID_ENV_VAR, TEST_CLIENT_ID);

  deviceCodeBody = {
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
  };
  tokenBodies = [];

  mockValidateGitHubToken.mockResolvedValue({ valid: true, login: "octocat" });
  installFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  global.fetch = realFetch;
});

describe("start → poll → success, over the real transport", () => {
  it("sends the device code GitHub issued back to GitHub, and to nobody else", async () => {
    tokenBodies = [
      { error: "authorization_pending" },
      { access_token: ACCESS_TOKEN, scope: "repo,read:user", token_type: "bearer" },
    ];

    const { res: startRes, json: startJson, handle } = await startFlow();

    expect(startRes.status).toBe(200);
    expect(startJson.data.userCode).toBe(USER_CODE);
    // The start request asked GitHub with the configured client id.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(GITHUB_DEVICE_CODE_URL);
    expect(sentParams(0).get("client_id")).toBe(TEST_CLIENT_ID);

    const pending = await poll(handle);
    expect(pending.res.status).toBe(200);
    expect(pending.json.data.state).toBe("pending");

    // The seam: the device code the store kept is what reaches GitHub's token
    // endpoint — not a value the route invented, and not the handle.
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(GITHUB_ACCESS_TOKEN_URL);
    expect(sentParams(1).get("device_code")).toBe(DEVICE_CODE);
    expect(sentParams(1).get("device_code")).not.toBe(handle);

    const success = await poll(handle);
    expect(success.res.status).toBe(200);
    expect(success.json.data.state).toBe("success");
    expect(success.json.data.login).toBe("octocat");
    // Scopes survive GitHub's comma-separated form all the way to the client.
    expect(success.json.data.scopes).toEqual(["repo", "read:user"]);
    expect(success.json.data.tokenSource).toBe("oauth_device");

    // The token GitHub issued is the one that got stored, under the existing key.
    const written = dbMockState.insertCalls as Array<{ key: string; value: string }>;
    expect(written.find((r) => r.key === "github_pat")?.value).toBe(
      JSON.stringify(ACCESS_TOKEN)
    );
    expect(
      JSON.parse(written.find((r) => r.key === "github_oauth_meta")?.value ?? "null")
    ).toMatchObject({
      login: "octocat",
      scopes: ["repo", "read:user"],
      tokenSource: "oauth_device",
    });

    // Neither secret ever crossed the wire.
    const wire = JSON.stringify([startJson, pending.json, success.json]);
    expect(wire).not.toContain(DEVICE_CODE);
    expect(wire).not.toContain(ACCESS_TOKEN);
  });
});

describe("GitHub's own error bodies, mapped end to end", () => {
  it("raises the cadence it reports, and measures the next tick against it", async () => {
    // Two consecutive slow_downs with no interval of GitHub's own: the +5
    // increment must compound, which only holds if the route PERSISTED the
    // first one. A route that reported without storing would say 10 twice.
    tokenBodies = [{ error: "slow_down" }, { error: "slow_down" }];

    const { handle } = await startFlow();

    const first = await poll(handle);
    expect(first.res.status).toBe(200);
    expect(first.json.data.state).toBe("slow_down");
    expect(first.json.data.interval).toBe(10);

    const second = await poll(handle);
    expect(second.json.data.interval).toBe(15);
  });

  it("answers 410 and spends the flow on expired_token", async () => {
    tokenBodies = [{ error: "expired_token" }];
    const { handle } = await startFlow();

    const { res, json } = await poll(handle);
    expect(res.status).toBe(410);
    expect(json.code).toBe("DEVICE_FLOW_EXPIRED");

    // Dropped, so a client that keeps polling is told to start over.
    expect((await poll(handle)).res.status).toBe(404);
  });

  it("answers 403 and spends the flow when the user refuses on github.com", async () => {
    tokenBodies = [{ error: "access_denied" }];
    const { handle } = await startFlow();

    const { res, json } = await poll(handle);
    expect(res.status).toBe(403);
    expect(json.code).toBe("DEVICE_FLOW_DENIED");
    expect((await poll(handle)).res.status).toBe(404);

    // A refused sign-in stores nothing.
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("answers 400 with the fallback code when no OAuth App is configured", async () => {
    // The standing state until the "Arij" OAuth App is registered: the UI
    // reads this code to fall back to pasting a PAT by hand.
    vi.stubEnv(GITHUB_OAUTH_CLIENT_ID_ENV_VAR, "");

    const { res, json } = await startFlow();

    expect(res.status).toBe(400);
    expect(json.code).toBe("CLIENT_ID_NOT_CONFIGURED");
    // It refused without asking GitHub anything.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
