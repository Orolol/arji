/**
 * `lib/github/device-flow.ts` — the OAuth device flow transport.
 *
 * The acceptance criterion this file exists to hold: every documented GitHub
 * error response maps onto a typed state, and `pollDeviceFlow` never throws.
 * So each error code gets its own case, and the network-failure and
 * garbage-response paths are asserted to resolve rather than reject.
 *
 * `fetch` is stubbed locally rather than through `__tests__/helpers/mock-fetch.ts`:
 * that helper only models `{ ok, json }`, and this module branches on `status`
 * and on `json()` itself throwing. Nothing here touches the network or the DB
 * (the module imports neither `db` nor anything from node_modules).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  startDeviceFlow,
  pollDeviceFlow,
  parseScopeList,
  resolveGitHubOAuthClientId,
  DeviceFlowError,
  ARIJ_GITHUB_OAUTH_CLIENT_ID,
  GITHUB_OAUTH_CLIENT_ID_ENV_VAR,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_FLOW_SCOPES,
  GITHUB_DEVICE_VERIFICATION_URL,
  DEVICE_FLOW_DEFAULT_INTERVAL_SECONDS,
  DEVICE_FLOW_DEFAULT_EXPIRES_IN_SECONDS,
  DEVICE_FLOW_SLOW_DOWN_INCREMENT_SECONDS,
} from "@/lib/github/device-flow";

const TEST_CLIENT_ID = "Iv1.test0client0id";

const realFetch = global.fetch;

/** One JSON answer, with a status the module can read. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A body `response.json()` cannot parse — GitHub's HTML error pages. */
function unparsableResponse(status = 404) {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  } as unknown as Response;
}

/** Records `(url, init)` so the request itself can be asserted, not just the result. */
type FetchMock = ReturnType<typeof mockFetchOnce>;

function mockFetchOnce(response: Response) {
  const fetchMock = vi.fn(
    async (_url?: unknown, _init?: RequestInit) => response
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** The URL of the single request the mock recorded. */
function sentUrl(fetchMock: FetchMock): string {
  return String(fetchMock.mock.calls[0]?.[0]);
}

/** The form body of that request, parsed. */
function sentParams(fetchMock: FetchMock): URLSearchParams {
  const init = fetchMock.mock.calls[0]?.[1];
  return new URLSearchParams(String(init?.body ?? ""));
}

function sentHeaders(fetchMock: FetchMock): Record<string, string> {
  return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  vi.stubEnv(GITHUB_OAUTH_CLIENT_ID_ENV_VAR, TEST_CLIENT_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  global.fetch = realFetch;
});

/* ------------------------------------------------------------------ */
/* Client ID resolution                                                */
/* ------------------------------------------------------------------ */

describe("resolveGitHubOAuthClientId", () => {
  it("prefers the environment override", () => {
    expect(resolveGitHubOAuthClientId()).toBe(TEST_CLIENT_ID);
  });

  it("falls back to the baked-in constant when the env var is blank", () => {
    vi.stubEnv(GITHUB_OAUTH_CLIENT_ID_ENV_VAR, "   ");
    expect(resolveGitHubOAuthClientId()).toBe(ARIJ_GITHUB_OAUTH_CLIENT_ID);
  });
});

/* ------------------------------------------------------------------ */
/* startDeviceFlow                                                     */
/* ------------------------------------------------------------------ */

describe("startDeviceFlow", () => {
  it("posts the client id and scopes as JSON-accepting form data", async () => {
    const fetchMock = mockFetchOnce(
      jsonResponse({
        device_code: "dc_secret",
        user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        expires_in: 899,
        interval: 5,
      })
    );

    const result = await startDeviceFlow();

    expect(sentUrl(fetchMock)).toBe(GITHUB_DEVICE_CODE_URL);
    // Accept: application/json is what makes GitHub answer JSON instead of a
    // URL-encoded body — the single most common way to get this flow wrong.
    expect(sentHeaders(fetchMock).Accept).toBe("application/json");
    expect(sentParams(fetchMock).get("client_id")).toBe(TEST_CLIENT_ID);
    expect(sentParams(fetchMock).get("scope")).toBe(GITHUB_DEVICE_FLOW_SCOPES);

    expect(result).toEqual({
      deviceCode: "dc_secret",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresIn: 899,
      interval: 5,
    });
  });

  it("passes explicitly requested scopes through", async () => {
    const fetchMock = mockFetchOnce(
      jsonResponse({ device_code: "dc", user_code: "AAAA-BBBB" })
    );

    await startDeviceFlow("read:user");

    expect(sentParams(fetchMock).get("scope")).toBe("read:user");
  });

  it("fills in defaults when GitHub omits interval, expiry and URI", async () => {
    mockFetchOnce(jsonResponse({ device_code: "dc", user_code: "AAAA-BBBB" }));

    const result = await startDeviceFlow();

    expect(result.interval).toBe(DEVICE_FLOW_DEFAULT_INTERVAL_SECONDS);
    expect(result.expiresIn).toBe(DEVICE_FLOW_DEFAULT_EXPIRES_IN_SECONDS);
    expect(result.verificationUri).toBe(GITHUB_DEVICE_VERIFICATION_URL);
  });

  it("coerces numeric strings, as a form-encoding proxy would send them", async () => {
    mockFetchOnce(
      jsonResponse({
        device_code: "dc",
        user_code: "AAAA-BBBB",
        expires_in: "900",
        interval: "10",
      })
    );

    const result = await startDeviceFlow();

    expect(result.expiresIn).toBe(900);
    expect(result.interval).toBe(10);
  });

  it("refuses without calling GitHub when no client id is configured", async () => {
    vi.stubEnv(GITHUB_OAUTH_CLIENT_ID_ENV_VAR, "");
    const fetchMock = mockFetchOnce(jsonResponse({}));

    await expect(startDeviceFlow()).rejects.toMatchObject({
      name: "DeviceFlowError",
      code: "CLIENT_ID_NOT_CONFIGURED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a GitHub error body to GITHUB_ERROR with GitHub's own wording", async () => {
    mockFetchOnce(
      jsonResponse(
        {
          error: "unauthorized_client",
          error_description: "The client is not authorized for this flow.",
        },
        401
      )
    );

    await expect(startDeviceFlow()).rejects.toMatchObject({
      code: "GITHUB_ERROR",
      message: "The client is not authorized for this flow.",
    });
  });

  it("maps an unreadable (HTML) response to MALFORMED_RESPONSE", async () => {
    mockFetchOnce(unparsableResponse(404));

    await expect(startDeviceFlow()).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });

  it("maps a response missing the device code to MALFORMED_RESPONSE", async () => {
    mockFetchOnce(jsonResponse({ user_code: "AAAA-BBBB" }));

    await expect(startDeviceFlow()).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });

  it("maps a network failure to GITHUB_UNREACHABLE", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const error = await startDeviceFlow().catch((e) => e);

    expect(error).toBeInstanceOf(DeviceFlowError);
    expect(error.code).toBe("GITHUB_UNREACHABLE");
  });
});

/* ------------------------------------------------------------------ */
/* pollDeviceFlow — the state mapping                                  */
/* ------------------------------------------------------------------ */

describe("pollDeviceFlow", () => {
  it("sends the device-code grant type verbatim", async () => {
    const fetchMock = mockFetchOnce(
      jsonResponse({ access_token: "gho_token", scope: "repo,read:user" })
    );

    await pollDeviceFlow("dc_secret");

    expect(sentUrl(fetchMock)).toBe(GITHUB_ACCESS_TOKEN_URL);
    const params = sentParams(fetchMock);
    expect(params.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:device_code"
    );
    expect(params.get("device_code")).toBe("dc_secret");
    expect(params.get("client_id")).toBe(TEST_CLIENT_ID);
  });

  it("returns success with the token and parsed scopes", async () => {
    mockFetchOnce(
      jsonResponse({
        access_token: "gho_token",
        token_type: "bearer",
        scope: "repo,read:user",
      })
    );

    await expect(pollDeviceFlow("dc")).resolves.toEqual({
      state: "success",
      accessToken: "gho_token",
      scopes: ["repo", "read:user"],
    });
  });

  it("maps authorization_pending to pending", async () => {
    mockFetchOnce(jsonResponse({ error: "authorization_pending" }));

    await expect(pollDeviceFlow("dc")).resolves.toEqual({ state: "pending" });
  });

  it("maps expired_token to expired", async () => {
    mockFetchOnce(jsonResponse({ error: "expired_token" }));

    await expect(pollDeviceFlow("dc")).resolves.toEqual({ state: "expired" });
  });

  it("maps access_denied to denied", async () => {
    mockFetchOnce(jsonResponse({ error: "access_denied" }));

    await expect(pollDeviceFlow("dc")).resolves.toEqual({ state: "denied" });
  });

  it("maps incorrect_device_code to a terminal error carrying the raw code", async () => {
    mockFetchOnce(jsonResponse({ error: "incorrect_device_code" }, 400));

    await expect(pollDeviceFlow("dc")).resolves.toMatchObject({
      state: "error",
      code: "incorrect_device_code",
    });
  });

  it("maps an error code GitHub has not documented yet to error, not a throw", async () => {
    mockFetchOnce(jsonResponse({ error: "some_future_code" }, 400));

    await expect(pollDeviceFlow("dc")).resolves.toMatchObject({
      state: "error",
      code: "some_future_code",
    });
  });

  describe("slow_down", () => {
    it("increases the caller's current interval by five seconds", async () => {
      mockFetchOnce(jsonResponse({ error: "slow_down" }));

      await expect(pollDeviceFlow("dc", 5)).resolves.toEqual({
        state: "slow_down",
        interval: 5 + DEVICE_FLOW_SLOW_DOWN_INCREMENT_SECONDS,
      });
    });

    it("keeps increasing across repeated slow_downs", async () => {
      mockFetchOnce(jsonResponse({ error: "slow_down" }));

      await expect(pollDeviceFlow("dc", 10)).resolves.toEqual({
        state: "slow_down",
        interval: 15,
      });
    });

    it("honours a larger interval sent by GitHub", async () => {
      mockFetchOnce(jsonResponse({ error: "slow_down", interval: 30 }));

      await expect(pollDeviceFlow("dc", 5)).resolves.toEqual({
        state: "slow_down",
        interval: 30,
      });
    });

    it("never slows down less than the +5 floor, whatever GitHub suggests", async () => {
      mockFetchOnce(jsonResponse({ error: "slow_down", interval: 1 }));

      await expect(pollDeviceFlow("dc", 5)).resolves.toEqual({
        state: "slow_down",
        interval: 10,
      });
    });
  });

  it("returns an error state instead of throwing on a network failure", async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(pollDeviceFlow("dc")).resolves.toMatchObject({
      state: "error",
      code: "github_unreachable",
    });
  });

  it("returns an error state instead of throwing on an unreadable response", async () => {
    mockFetchOnce(unparsableResponse(502));

    await expect(pollDeviceFlow("dc")).resolves.toMatchObject({
      state: "error",
      code: "malformed_response",
    });
  });

  it("returns an error state when no client id is configured", async () => {
    vi.stubEnv(GITHUB_OAUTH_CLIENT_ID_ENV_VAR, "");
    const fetchMock = mockFetchOnce(jsonResponse({}));

    await expect(pollDeviceFlow("dc")).resolves.toMatchObject({
      state: "error",
      code: "client_id_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never echoes the response body — a token cannot leak into an error", async () => {
    // 200, no usable `access_token`, but a token-shaped value sitting in the
    // body. The malformed-response branch must describe the failure without
    // quoting what it received.
    mockFetchOnce(
      jsonResponse({
        access_token: null,
        renewal_token: "gho_MUSTNOTAPPEAR",
        scope: "repo",
      })
    );

    const result = await pollDeviceFlow("dc");

    expect(result.state).toBe("error");
    expect(JSON.stringify(result)).not.toContain("gho_MUSTNOTAPPEAR");
  });
});

/* ------------------------------------------------------------------ */
/* parseScopeList                                                      */
/* ------------------------------------------------------------------ */

describe("parseScopeList", () => {
  it("splits GitHub's comma-separated token-endpoint form", () => {
    expect(parseScopeList("repo,read:user")).toEqual(["repo", "read:user"]);
  });

  it("splits the space-separated request form", () => {
    expect(parseScopeList("repo read:user")).toEqual(["repo", "read:user"]);
  });

  it("returns an empty list for a missing or non-string scope", () => {
    expect(parseScopeList(undefined)).toEqual([]);
    expect(parseScopeList("")).toEqual([]);
    expect(parseScopeList(42)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance criteria that are properties of the source itself        */
/* ------------------------------------------------------------------ */

describe("device-flow module source", () => {
  const source = readFileSync(
    resolve(__dirname, "../lib/github/device-flow.ts"),
    "utf8"
  );

  it("adds no dependency — it imports nothing at all", () => {
    // "Aucune dépendance nouvelle dans package.json (fetch natif)": the
    // module has no imports, bare-specifier or otherwise, so it cannot pull
    // one in without this line reddening.
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("holds no secret and never asks for a client secret", () => {
    expect(source).not.toContain("client_secret");
    expect(ARIJ_GITHUB_OAUTH_CLIENT_ID).not.toMatch(/^(ghp|gho|ghu|ghs)_/);
    // Token-shaped literals: GitHub's own prefixes.
    expect(source).not.toMatch(/["'`](ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9]/);
  });
});
