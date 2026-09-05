"use client";

/**
 * Drives "Se connecter avec GitHub" from the browser side.
 *
 * The two routes it talks to (`POST /api/auth/github/device/{start,poll}`) are
 * deliberately stateless-per-call: `start` mints a device/user code pair and
 * hands back an OPAQUE HANDLE, `poll` advances that handle by exactly one tick.
 * Owning the cadence is therefore this hook's job, and the reason it exists at
 * all — a server-side loop would hold one request open for fifteen minutes and
 * take the user's ability to give up with it.
 *
 * WHAT NEVER REACHES THIS FILE: the `device_code` and the access token. The
 * handle stands in for the first (see `lib/github/device-flow-store.ts`) and
 * the poll route writes the second straight into `settings.github_pat`, so the
 * success payload this hook reads is a login, a scope list and a timestamp —
 * the `github_oauth_meta` shape, nothing more.
 *
 * The cadence rules are GitHub's, relayed by the poll route:
 * - wait `interval` seconds between ticks;
 * - a `slow_down` answer carries a RAISED interval, already recorded
 *   server-side, and the next tick must use it or earn another;
 * - the pair dies at `expiresIn`, and polling a dead code only ever returns
 *   the same refusal.
 */

import { useEffect, useRef, useState } from "react";

import type { GitHubOAuthMeta } from "@/lib/github/oauth-meta";

export const DEVICE_FLOW_START_URL = "/api/auth/github/device/start";
export const DEVICE_FLOW_POLL_URL = "/api/auth/github/device/poll";
export const DEVICE_FLOW_CANCEL_URL = "/api/auth/github/device/cancel";

/**
 * How many ticks in a row may fail transiently before the flow gives up.
 *
 * A 503 (GitHub unreachable) or a dead `fetch` leaves the device code valid,
 * so the right answer is to keep polling — but silently retrying for fifteen
 * minutes behind a "waiting for authorization" panel is a failure the user
 * never sees. After this many, the panel says so and offers Réessayer.
 */
export const DEVICE_FLOW_MAX_TRANSIENT_FAILURES = 5;

/** Floor on the poll cadence, so a nonsense `interval` cannot busy-loop. */
const MIN_POLL_INTERVAL_SECONDS = 1;

/**
 * Lifetime assumed when `start` reports none. GitHub's documented value, and
 * the store's own cap — a missing field must not collapse the deadline onto
 * `now`, which would expire the flow before its first tick.
 */
const DEFAULT_EXPIRES_IN_SECONDS = 900;

const EXPIRED_MESSAGE =
  "Ce code a expiré. Relancez la connexion pour en obtenir un nouveau.";
const UNREADABLE_START_MESSAGE =
  "GitHub n'a pas renvoyé de code utilisable. Réessayez.";
const UNREADABLE_POLL_MESSAGE =
  "GitHub a confirmé la connexion mais la réponse est illisible. Réessayez.";
const UNREACHABLE_MESSAGE =
  "Connexion à Arij impossible. Vérifiez que le serveur tourne, puis réessayez.";
const FALLBACK_POLL_MESSAGE =
  "La connexion GitHub a échoué. Réessayez.";

/**
 * What the card renders.
 *
 * There is no `connected` member on purpose: a finished sign-in is DURABLE
 * state (a row in `settings`), owned by the card and its `GET /api/settings`
 * read. The hook reports it once through `onConnected` and returns to `idle`,
 * so a remount cannot resurrect a stale "just connected" banner.
 */
export type DeviceFlowState =
  | { status: "idle" }
  | { status: "starting" }
  /** Code minted, user is authorizing on github.com, ticks are scheduled. */
  | { status: "awaiting"; userCode: string; verificationUri: string }
  /** Terminal: expired, denied, superseded, or refused. `Réessayer` restarts. */
  | { status: "failed"; code: string; message: string };

export interface GitHubDeviceFlow {
  state: DeviceFlowState;
  /** Begin (or restart) a flow. Supersedes any flow already running. */
  start: () => void;
  /** Abandon the flow and forget its timer. */
  cancel: () => void;
}

/* ------------------------------------------------------------------ */
/* Payload readers — everything crossing the wire is untrusted shape    */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;

function readString(source: Json, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function readInterval(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * The success payload, re-read rather than trusted: this is the object the
 * card will render as "Connecté en tant que …", and a missing `login` there
 * would claim a connection to nobody.
 */
function readMeta(data: Json): GitHubOAuthMeta | null {
  const login = readString(data, "login");
  if (!login) return null;

  const scopes = data["scopes"];
  const obtainedAt = readString(data, "obtainedAt");
  const tokenSource = readString(data, "tokenSource");

  return {
    login,
    scopes: Array.isArray(scopes)
      ? scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    obtainedAt: obtainedAt || new Date().toISOString(),
    tokenSource: tokenSource === "manual" ? "manual" : "oauth_device",
  };
}

/* ------------------------------------------------------------------ */
/* The poll loop — module scope, so no render can capture a stale copy  */
/* ------------------------------------------------------------------ */

/**
 * Everything one running flow needs. `isCurrent` is the generation guard: a
 * tick whose flow was cancelled or superseded resolves into a no-op instead
 * of writing state for a sign-in nobody is watching any more.
 */
interface PollContext {
  handle: string;
  /** Epoch ms after which the device code is dead, whatever GitHub says. */
  deadline: number;
  isCurrent: () => boolean;
  setTimer: (timer: ReturnType<typeof setTimeout>) => void;
  setState: (state: DeviceFlowState) => void;
  onConnected: (meta: GitHubOAuthMeta) => void;
}

/**
 * Tell the server the flow is over. Fire-and-forget, and it has to be.
 *
 * Stopping the timers only stops this tab from asking. The server still holds
 * the device code, and a tick already awaiting GitHub still comes back holding
 * a real token — which the poll route would write to `settings`, connecting an
 * account the user just walked away from. Releasing the slot makes that tick's
 * pre-write claim fail, so it discards the token instead.
 *
 * Nothing is awaited and nothing is reported: this is called from `cancel()`
 * and from an unmount effect, both of which are synchronous, and a failure
 * here costs at worst a device code that expires by itself in fifteen minutes.
 * `keepalive` is what carries the request through the unmount case.
 */
function releaseFlow(handle: string): void {
  if (!handle) return;
  void fetch(DEVICE_FLOW_CANCEL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle }),
    keepalive: true,
  }).catch(() => {
    // Deliberately silent — see above.
  });
}

function scheduleTick(
  context: PollContext,
  intervalSeconds: number,
  transientFailures: number
): void {
  const delayMs = Math.max(MIN_POLL_INTERVAL_SECONDS, intervalSeconds) * 1000;
  context.setTimer(
    setTimeout(() => {
      void runPollTick(context, intervalSeconds, transientFailures);
    }, delayMs)
  );
}

/** Keep the flow alive, or surrender once the transient budget is spent. */
function retryOrGiveUp(
  context: PollContext,
  intervalSeconds: number,
  transientFailures: number,
  code: string,
  message: string
): void {
  const next = transientFailures + 1;
  if (next >= DEVICE_FLOW_MAX_TRANSIENT_FAILURES) {
    context.setState({ status: "failed", code, message });
    return;
  }
  scheduleTick(context, intervalSeconds, next);
}

async function runPollTick(
  context: PollContext,
  intervalSeconds: number,
  transientFailures: number
): Promise<void> {
  if (!context.isCurrent()) return;

  // Checked here rather than only on GitHub's `expired_token`: the deadline is
  // ours (the store caps a flow at 15 minutes), and a browser that has been
  // asleep should report an expiry without a pointless round-trip first.
  if (Date.now() >= context.deadline) {
    context.setState({
      status: "failed",
      code: "DEVICE_FLOW_EXPIRED",
      message: EXPIRED_MESSAGE,
    });
    return;
  }

  let ok = false;
  let status = 0;
  let payload: Json = {};

  try {
    const response = await fetch(DEVICE_FLOW_POLL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: context.handle }),
    });
    ok = response.ok;
    status = response.status;
    payload = ((await response.json().catch(() => ({}))) ?? {}) as Json;
  } catch {
    // Arij itself did not answer — a dev server restarting mid sign-in is the
    // usual cause, and the device code outlives it.
    if (!context.isCurrent()) return;
    retryOrGiveUp(
      context,
      intervalSeconds,
      transientFailures,
      "NETWORK_ERROR",
      UNREACHABLE_MESSAGE
    );
    return;
  }

  if (!context.isCurrent()) return;

  if (ok) {
    const data = ((payload["data"] ?? {}) as Json) ?? {};
    const state = readString(data, "state");

    if (state === "success") {
      const meta = readMeta(data);
      if (!meta) {
        context.setState({
          status: "failed",
          code: "MALFORMED_RESPONSE",
          message: UNREADABLE_POLL_MESSAGE,
        });
        return;
      }
      // Back to idle: the connection now lives in `settings`, and the card
      // renders it from there.
      context.setState({ status: "idle" });
      context.onConnected(meta);
      return;
    }

    // `pending` and `slow_down` are the same instruction — keep going — and
    // differ only in the cadence they hand back. The counter resets: a tick
    // that reached GitHub proves the transient failures are over.
    scheduleTick(context, readInterval(data["interval"], intervalSeconds), 0);
    return;
  }

  const code = readString(payload, "code") || `HTTP_${status}`;
  const message = readString(payload, "error") || FALLBACK_POLL_MESSAGE;

  // 503 is the ONE refusal a flow survives: GitHub was unreachable for this
  // tick and the device code is still good. 410 (expired), 403 (denied), 404
  // (superseded, or lost to a restart) and 502 (GitHub refused the flow) are
  // all terminal — polling them again returns the same answer forever.
  if (status === 503) {
    retryOrGiveUp(context, intervalSeconds, transientFailures, code, message);
    return;
  }

  context.setState({ status: "failed", code, message });
}

/* ------------------------------------------------------------------ */
/* The hook                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param onConnected Called once, with the `github_oauth_meta` the poll route
 *   just persisted. The token is already stored by then; this is only the
 *   signal to re-render the card as connected.
 */
export function useGitHubDeviceFlow(
  onConnected: (meta: GitHubOAuthMeta) => void
): GitHubDeviceFlow {
  const [state, setState] = useState<DeviceFlowState>({ status: "idle" });

  // Bumped by every start, cancel and unmount. A tick or an in-flight `start`
  // compares against the value it captured; a mismatch means "you are the
  // past" and it writes nothing.
  const generationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConnectedRef = useRef(onConnected);
  // The handle of the flow the server still holds a device code for, or "".
  // Cleared the moment a flow reaches a terminal state so a later cancel
  // cannot release a slot that a newer `start` has since taken.
  const liveHandleRef = useRef("");

  useEffect(() => {
    onConnectedRef.current = onConnected;
  });

  useEffect(
    () => () => {
      // A timer that fires after the card unmounts would set state on a dead
      // tree, and a flow nobody is watching is a device code held for nothing
      // — so the server is told to drop it too, not just this tab.
      generationRef.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      const handle = liveHandleRef.current;
      liveHandleRef.current = "";
      releaseFlow(handle);
    },
    []
  );

  function supersede(): number {
    generationRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    return generationRef.current;
  }

  async function beginFlow(generation: number): Promise<void> {
    const isCurrent = () => generationRef.current === generation;
    const write = (next: DeviceFlowState) => {
      if (!isCurrent()) return;
      // `awaiting` is the only state with a flow still worth releasing. Every
      // other one the tick can write is terminal — success returns to `idle`,
      // and the server has already settled the slot by then — so forgetting
      // the handle here keeps a later cancel or unmount from posting a
      // pointless release for a flow nobody holds.
      if (next.status !== "awaiting") liveHandleRef.current = "";
      setState(next);
    };

    let ok = false;
    let payload: Json = {};

    try {
      // No body at all — `validateOptionalBody` on the route exists precisely
      // so the most natural call shape is not a 400. Scopes are the server's
      // to decide, never a parameter here.
      const response = await fetch(DEVICE_FLOW_START_URL, { method: "POST" });
      ok = response.ok;
      payload = ((await response.json().catch(() => ({}))) ?? {}) as Json;
    } catch {
      write({
        status: "failed",
        code: "NETWORK_ERROR",
        message: UNREACHABLE_MESSAGE,
      });
      return;
    }

    if (!isCurrent()) return;

    if (!ok) {
      // Every refusal here is already a sentence the user can act on —
      // `CLIENT_ID_NOT_CONFIGURED` says to paste a PAT instead, which is the
      // field sitting right below.
      write({
        status: "failed",
        code: readString(payload, "code") || "DEVICE_FLOW_START_FAILED",
        message: readString(payload, "error") || UNREADABLE_START_MESSAGE,
      });
      return;
    }

    const data = ((payload["data"] ?? {}) as Json) ?? {};
    const handle = readString(data, "handle");
    const userCode = readString(data, "userCode");
    const verificationUri = readString(data, "verificationUri");

    if (!handle || !userCode || !verificationUri) {
      write({
        status: "failed",
        code: "MALFORMED_RESPONSE",
        message: UNREADABLE_START_MESSAGE,
      });
      return;
    }

    liveHandleRef.current = handle;
    write({ status: "awaiting", userCode, verificationUri });

    const interval = readInterval(data["interval"], MIN_POLL_INTERVAL_SECONDS);
    const expiresIn = readInterval(data["expiresIn"], DEFAULT_EXPIRES_IN_SECONDS);

    scheduleTick(
      {
        handle,
        deadline: Date.now() + expiresIn * 1000,
        isCurrent,
        setTimer: (timer) => {
          if (isCurrent()) timerRef.current = timer;
          else clearTimeout(timer);
        },
        setState: write,
        onConnected: (meta) => {
          if (isCurrent()) onConnectedRef.current(meta);
        },
      },
      interval,
      0
    );
  }

  function start(): void {
    // The server keeps ONE slot, so a second start invalidates the first
    // handle server-side anyway; superseding here keeps the two in step.
    const generation = supersede();
    liveHandleRef.current = "";
    setState({ status: "starting" });
    void beginFlow(generation);
  }

  function cancel(): void {
    supersede();
    // The server half of giving up. Without it, cancelling stops the polling
    // but leaves a tick that is already in flight free to come back with a
    // token and connect the account anyway.
    const handle = liveHandleRef.current;
    liveHandleRef.current = "";
    releaseFlow(handle);
    setState({ status: "idle" });
  }

  return { state, start, cancel };
}
