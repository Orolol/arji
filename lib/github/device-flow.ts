/**
 * GitHub OAuth Device Flow — the transport half of "Se connecter avec GitHub".
 *
 * This is the flow `gh auth login` uses: the app asks GitHub for a device
 * code, shows the user an 8-character code to type on github.com/login/device,
 * and polls until the user authorizes. There is no client secret and no
 * callback URL — that is the whole point of the device flow, and why a local
 * app with no public origin can use it at all.
 *
 * Two functions, two failure conventions, deliberately different:
 *
 * - `pollDeviceFlow` NEVER throws. It is called on a timer, and every answer
 *   GitHub can give — including `authorization_pending`, `slow_down`,
 *   `expired_token`, `access_denied` and `incorrect_device_code` — is mapped
 *   onto a discriminated state. A polling loop must never have to guess
 *   whether a rejection means "keep waiting" or "give up".
 * - `startDeviceFlow` throws exactly one type, {@link DeviceFlowError}, always
 *   carrying a machine-readable `code` — the same shape
 *   `GitHubNotConfiguredError` uses in `./client.ts`, so a route can answer
 *   `{ error, code }` instead of letting a 500 through.
 *
 * Secrets: there are none in this file. The client ID is public by design
 * (see {@link ARIJ_GITHUB_OAUTH_CLIENT_ID}), and the access token GitHub
 * returns is handed straight back to the caller — never logged, never
 * embedded in an error message, never written here. That last rule is why no
 * function in this module interpolates a raw response body into an `Error`:
 * the success body contains the token, and a "malformed response" message
 * built from it would leak it into logs.
 *
 * Native `fetch` only — no new dependency.
 */

/* ------------------------------------------------------------------ */
/* Endpoints, client ID and tunables                                   */
/* ------------------------------------------------------------------ */

/** Where a device/user code pair is minted. */
export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";

/** Where a device code is exchanged for an access token. */
export const GITHUB_ACCESS_TOKEN_URL =
  "https://github.com/login/oauth/access_token";

/** Page the user opens to type their code. Shown in the UI. */
export const GITHUB_DEVICE_VERIFICATION_URL = "https://github.com/login/device";

/**
 * Scopes requested in phase 1. `repo` is broad — full read/write on every
 * private repository the user can reach — but it is the structural minimum
 * for an OAuth App: fine-grained scoping needs a GitHub App, deferred to v2.
 * `read:user` is what resolves the login shown in Settings.
 */
export const GITHUB_DEVICE_FLOW_SCOPES = "repo read:user";

/**
 * The public client ID of the "Arij" OAuth App.
 *
 * Public by design: the device flow has no client secret, so this value is
 * not a credential and belongs in the source tree rather than in settings.
 *
 * EMPTY ON PURPOSE. The OAuth App has not been registered yet — registering
 * it is a human step (it also fixes the app name, icon and description shown
 * on GitHub's device-authorization screen), and inventing a plausible-looking
 * hex string here would fail at runtime with a confusing GitHub error that
 * reads like a bug in this module. Until it is filled in, `startDeviceFlow`
 * refuses with `CLIENT_ID_NOT_CONFIGURED` and the manual-PAT path in Settings
 * remains the working route. {@link GITHUB_OAUTH_CLIENT_ID_ENV_VAR} overrides
 * it for anyone testing against their own OAuth App in the meantime.
 */
export const ARIJ_GITHUB_OAUTH_CLIENT_ID = "";

/** Env override for {@link ARIJ_GITHUB_OAUTH_CLIENT_ID}. */
export const GITHUB_OAUTH_CLIENT_ID_ENV_VAR = "ARIJ_GITHUB_OAUTH_CLIENT_ID";

/**
 * Fallback poll cadence, in seconds, when GitHub does not say. GitHub's
 * documented default is 5s; polling faster earns a `slow_down`.
 */
export const DEVICE_FLOW_DEFAULT_INTERVAL_SECONDS = 5;

/** What `slow_down` adds to the cadence when GitHub sends no new interval. */
export const DEVICE_FLOW_SLOW_DOWN_INCREMENT_SECONDS = 5;

/** Fallback lifetime, in seconds, when GitHub does not say. */
export const DEVICE_FLOW_DEFAULT_EXPIRES_IN_SECONDS = 900;

/** Hard cap on a single request to GitHub. */
export const DEVICE_FLOW_REQUEST_TIMEOUT_MS = 10_000;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** What `startDeviceFlow` hands back. `deviceCode` must not leave the server. */
export interface DeviceFlowStart {
  /** Server-side secret half of the pair. Never send this to the browser. */
  deviceCode: string;
  /** The 8-character code the user types on GitHub. Safe to display. */
  userCode: string;
  /** Where the user should type it, as GitHub reports it. */
  verificationUri: string;
  /** Lifetime of the pair, in seconds. */
  expiresIn: number;
  /** Minimum seconds between polls, per GitHub. */
  interval: number;
}

/** Machine-readable reasons `startDeviceFlow` can refuse. */
export type DeviceFlowErrorCode =
  /** The OAuth App client ID has not been filled in — see the constant. */
  | "CLIENT_ID_NOT_CONFIGURED"
  /** Network failure or timeout; GitHub never answered. */
  | "GITHUB_UNREACHABLE"
  /** GitHub answered, and the answer was an error. */
  | "GITHUB_ERROR"
  /** GitHub answered with something this module cannot read. */
  | "MALFORMED_RESPONSE";

/**
 * The only error `startDeviceFlow` throws. Carries a `code` so a route can
 * translate it into a status without pattern-matching prose — the same
 * contract as `GitHubNotConfiguredError` in `./client.ts`.
 */
export class DeviceFlowError extends Error {
  readonly code: DeviceFlowErrorCode;

  constructor(code: DeviceFlowErrorCode, message: string) {
    super(message);
    this.name = "DeviceFlowError";
    this.code = code;
  }
}

/**
 * Every answer a poll tick can produce.
 *
 * `pending` and `slow_down` mean keep going; `slow_down` additionally carries
 * the cadence the caller must switch to. `success`, `expired` and `denied`
 * are terminal. `error` is terminal too, and exists so an unrecognised
 * GitHub error code (`incorrect_device_code`, `unsupported_grant_type`, a
 * future one) surfaces as data rather than as an exception.
 */
export type DeviceFlowPollResult =
  | { state: "pending" }
  | { state: "slow_down"; interval: number }
  | { state: "success"; accessToken: string; scopes: string[] }
  | { state: "expired" }
  | { state: "denied" }
  | { state: "error"; code: string; message: string };

/* ------------------------------------------------------------------ */
/* Small parsing helpers                                               */
/* ------------------------------------------------------------------ */

/** The resolved client ID: env override first, then the baked-in constant. */
export function resolveGitHubOAuthClientId(): string {
  const fromEnv = process.env[GITHUB_OAUTH_CLIENT_ID_ENV_VAR];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return ARIJ_GITHUB_OAUTH_CLIENT_ID.trim();
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Reads a numeric field that GitHub may send as a number or, when a proxy
 * re-encodes the response as form data, as a numeric string. Falls back to
 * `fallback` for anything else, including a negative or non-finite value.
 */
function readPositiveNumber(
  source: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const value = source[key];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Splits GitHub's `scope` field into a list. GitHub returns it
 * comma-separated on the token endpoint (`"repo,read:user"`) while the
 * request side is space-separated, so both separators are accepted.
 */
export function parseScopeList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * POSTs form-encoded parameters and returns the parsed JSON object.
 *
 * `Accept: application/json` is what makes GitHub answer with JSON instead of
 * a URL-encoded body — the single most common way to get this flow wrong.
 *
 * Throws only {@link DeviceFlowError}. Note what is NOT in the messages: the
 * response body. On the token endpoint that body carries the access token.
 */
async function postForm(
  url: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "arij",
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(DEVICE_FLOW_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new DeviceFlowError(
      "GITHUB_UNREACHABLE",
      "Could not reach GitHub to start the sign-in. Check your network and try again."
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A non-JSON body means GitHub answered with an HTML error page — the
    // usual cause is an unknown client ID. The status is the only detail
    // worth surfacing; the body is not.
    throw new DeviceFlowError(
      "MALFORMED_RESPONSE",
      `GitHub returned an unreadable response (HTTP ${response.status}).`
    );
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DeviceFlowError(
      "MALFORMED_RESPONSE",
      `GitHub returned an unexpected response (HTTP ${response.status}).`
    );
  }

  return payload as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Step 1 — request a device/user code pair                            */
/* ------------------------------------------------------------------ */

/**
 * Asks GitHub for a device code and the user code to display.
 *
 * The returned `deviceCode` is the secret half of the pair: it is what
 * `pollDeviceFlow` exchanges for a token, so it stays server-side (the API
 * route keeps it in an in-memory map and hands the browser an opaque handle).
 *
 * @param scopes Space-separated scopes; defaults to {@link GITHUB_DEVICE_FLOW_SCOPES}.
 * @throws {DeviceFlowError} — the only error type this can produce.
 */
export async function startDeviceFlow(
  scopes: string = GITHUB_DEVICE_FLOW_SCOPES
): Promise<DeviceFlowStart> {
  const clientId = resolveGitHubOAuthClientId();
  if (!clientId) {
    throw new DeviceFlowError(
      "CLIENT_ID_NOT_CONFIGURED",
      "The Arij GitHub OAuth App is not configured yet. Paste a personal access token instead, " +
        `or set ${GITHUB_OAUTH_CLIENT_ID_ENV_VAR} to your own OAuth App's client ID.`
    );
  }

  const payload = await postForm(GITHUB_DEVICE_CODE_URL, {
    client_id: clientId,
    scope: scopes.trim(),
  });

  const errorCode = readString(payload, "error");
  if (errorCode) {
    throw new DeviceFlowError(
      "GITHUB_ERROR",
      describeGitHubError(errorCode, readString(payload, "error_description"))
    );
  }

  const deviceCode = readString(payload, "device_code");
  const userCode = readString(payload, "user_code");
  if (!deviceCode || !userCode) {
    throw new DeviceFlowError(
      "MALFORMED_RESPONSE",
      "GitHub did not return a device code. Try signing in again."
    );
  }

  return {
    deviceCode,
    userCode,
    verificationUri:
      readString(payload, "verification_uri") || GITHUB_DEVICE_VERIFICATION_URL,
    expiresIn: readPositiveNumber(
      payload,
      "expires_in",
      DEVICE_FLOW_DEFAULT_EXPIRES_IN_SECONDS
    ),
    interval: readPositiveNumber(
      payload,
      "interval",
      DEVICE_FLOW_DEFAULT_INTERVAL_SECONDS
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Step 2 — poll for the token                                         */
/* ------------------------------------------------------------------ */

/**
 * One poll tick: exchange the device code for an access token, or report why
 * not yet.
 *
 * Never throws — a caller on a timer gets a state to branch on, including for
 * network failures and unknown GitHub error codes.
 *
 * @param deviceCode The secret from {@link startDeviceFlow}.
 * @param currentIntervalSeconds The cadence in use, so a `slow_down` with no
 *   `interval` of its own can be answered with "the current one, plus 5".
 */
export async function pollDeviceFlow(
  deviceCode: string,
  currentIntervalSeconds: number = DEVICE_FLOW_DEFAULT_INTERVAL_SECONDS
): Promise<DeviceFlowPollResult> {
  const clientId = resolveGitHubOAuthClientId();
  if (!clientId) {
    return {
      state: "error",
      code: "client_id_not_configured",
      message:
        "The Arij GitHub OAuth App is not configured yet. Paste a personal access token instead.",
    };
  }

  let payload: Record<string, unknown>;
  try {
    payload = await postForm(GITHUB_ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  } catch (error) {
    // postForm only throws DeviceFlowError, but the poll contract is
    // "never throws", so anything unexpected also becomes a state.
    const code =
      error instanceof DeviceFlowError ? error.code : "UNEXPECTED_ERROR";
    const message =
      error instanceof DeviceFlowError
        ? error.message
        : "Could not complete the GitHub sign-in. Try again.";
    return { state: "error", code: code.toLowerCase(), message };
  }

  const errorCode = readString(payload, "error");
  if (errorCode) {
    return mapPollError(
      errorCode,
      readString(payload, "error_description"),
      payload,
      currentIntervalSeconds
    );
  }

  const accessToken = readString(payload, "access_token");
  if (!accessToken) {
    // No token and no error code: nothing usable came back. Deliberately
    // says nothing about the body, which is where a token would be.
    return {
      state: "error",
      code: "malformed_response",
      message: "GitHub returned no access token. Try signing in again.",
    };
  }

  return {
    state: "success",
    accessToken,
    scopes: parseScopeList(payload["scope"]),
  };
}

/**
 * Maps GitHub's documented device-flow error codes onto poll states.
 *
 * `slow_down` prefers the interval GitHub sends; without one it adds
 * {@link DEVICE_FLOW_SLOW_DOWN_INCREMENT_SECONDS} to the current cadence.
 * Anything unrecognised — `incorrect_device_code`, `unsupported_grant_type`,
 * `incorrect_client_credentials`, a code GitHub adds later — lands on
 * `error` with the raw code preserved, so the caller stops instead of
 * polling a dead flow forever.
 */
function mapPollError(
  errorCode: string,
  description: string,
  payload: Record<string, unknown>,
  currentIntervalSeconds: number
): DeviceFlowPollResult {
  switch (errorCode) {
    case "authorization_pending":
      return { state: "pending" };

    case "slow_down": {
      const suggested = readPositiveNumber(payload, "interval", 0);
      const base =
        currentIntervalSeconds > 0
          ? currentIntervalSeconds
          : DEVICE_FLOW_DEFAULT_INTERVAL_SECONDS;
      return {
        state: "slow_down",
        interval: Math.max(
          suggested,
          base + DEVICE_FLOW_SLOW_DOWN_INCREMENT_SECONDS
        ),
      };
    }

    case "expired_token":
      return { state: "expired" };

    case "access_denied":
      return { state: "denied" };

    default:
      return {
        state: "error",
        code: errorCode,
        message: describeGitHubError(errorCode, description),
      };
  }
}

/**
 * Readable message for a GitHub error code. Prefers GitHub's own
 * `error_description`, which is safe to surface: it is prose about the
 * request, never anything from the token response.
 */
function describeGitHubError(errorCode: string, description: string): string {
  if (description) return description;

  switch (errorCode) {
    case "incorrect_device_code":
      return "GitHub did not recognise this sign-in. Start it again.";
    case "incorrect_client_credentials":
    case "unauthorized_client":
      return "GitHub rejected the Arij OAuth App. Paste a personal access token instead.";
    case "device_flow_disabled":
      return "The device flow is not enabled on the Arij OAuth App.";
    default:
      return `GitHub refused the sign-in (${errorCode}).`;
  }
}
