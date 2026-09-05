/**
 * In-memory store for the in-flight GitHub Device Flow.
 *
 * The `device_code` GitHub mints is the secret half of the pair: whoever holds
 * it can exchange it for an access token. It therefore never leaves the
 * server. The browser gets an opaque `handle` instead, and the poll route
 * resolves that handle back to the device code here — the same
 * globalThis-backed-singleton pattern as `lib/mcp/token-store.ts`, and for the
 * same reason: dev hot reloads re-evaluate module scope, and a module-local
 * map would drop a live flow mid-authorization.
 *
 * ONE SLOT, not a map. A user authorizing Arij on github.com is doing one
 * thing at one moment; a second `start` supersedes the first rather than
 * queueing beside it, so an abandoned flow (dialog closed, page reloaded)
 * cannot pin a slot for fifteen minutes. The superseded handle stops
 * resolving, which the poll route reports as an ordinary 404 — the client's
 * cue to start again.
 *
 * Nothing here is durable, and nothing needs to be: a server restart loses at
 * most one unfinished sign-in, and the user simply clicks the button again.
 * The token itself is written to `settings` by the poll route, which is the
 * durable half.
 */

import { createId } from "@/lib/utils/nanoid";
import {
  DEVICE_FLOW_DEFAULT_INTERVAL_SECONDS,
  type DeviceFlowStart,
} from "@/lib/github/device-flow";

/**
 * Hard ceiling on a flow's lifetime, whatever GitHub reports. GitHub's own
 * `expires_in` is 900s today, but it is their number, not our contract: this
 * cap is what bounds how long a device code can sit in this process's memory.
 */
export const DEVICE_FLOW_MAX_LIFETIME_MS = 15 * 60 * 1000;

/** A flow awaiting the user's authorization on github.com. */
export interface DeviceFlowRecord {
  /** Opaque, unguessable id handed to the browser. */
  handle: string;
  /** SERVER-ONLY. Never serialise this into an HTTP response or a log. */
  deviceCode: string;
  /** The 8-character code the user types. Safe to display. */
  userCode: string;
  /** Where they type it. */
  verificationUri: string;
  /**
   * Current poll cadence in seconds. Mutable: a `slow_down` from GitHub
   * raises it, and the next tick must use the raised value or earn another.
   */
  interval: number;
  /** Epoch ms when the flow was started. */
  createdAt: number;
  /** Epoch ms after which the flow is dead. */
  expiresAt: number;
  /**
   * True while a poll tick for this flow is awaiting GitHub.
   *
   * A device code may only be exchanged once. Two overlapping ticks (a client
   * that retried before the first answer came back, a double-clicked button)
   * would race for that single exchange, and the loser earns a `slow_down` at
   * best and burns the authorization at worst. The second tick is told to
   * keep waiting instead of reaching GitHub at all.
   */
  polling: boolean;
}

/** What the browser is allowed to see. Deliberately omits `deviceCode`. */
export interface ClientDeviceFlow {
  handle: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  /** Seconds left, so the UI can count down without trusting its own clock. */
  expiresIn: number;
}

/** Result of resolving a handle. `unknown` covers both never-seen and superseded. */
export type DeviceFlowLookup =
  | { state: "active"; record: DeviceFlowRecord }
  | { state: "expired" }
  | { state: "unknown" };

const STORE_GLOBAL_KEY = Symbol.for("arij.github-device-flow-store");

interface DeviceFlowSlot {
  active: DeviceFlowRecord | null;
}

type StoreGlobal = { [STORE_GLOBAL_KEY]?: DeviceFlowSlot };

function getSlot(): DeviceFlowSlot {
  const holder = globalThis as StoreGlobal;
  holder[STORE_GLOBAL_KEY] ??= { active: null };
  return holder[STORE_GLOBAL_KEY];
}

/**
 * Store a freshly minted flow, replacing whatever was in the slot.
 *
 * `expiresIn` is clamped to {@link DEVICE_FLOW_MAX_LIFETIME_MS}: GitHub could
 * report a longer lifetime, and the ceiling on how long we hold a device code
 * is ours to set, not theirs.
 */
export function rememberDeviceFlow(
  start: DeviceFlowStart,
  now: number = Date.now()
): DeviceFlowRecord {
  const lifetimeMs = Math.min(
    Math.max(start.expiresIn, 0) * 1000,
    DEVICE_FLOW_MAX_LIFETIME_MS
  );

  const record: DeviceFlowRecord = {
    handle: `gh-device-${createId()}${createId()}`,
    deviceCode: start.deviceCode,
    userCode: start.userCode,
    verificationUri: start.verificationUri,
    interval:
      start.interval > 0 ? start.interval : DEVICE_FLOW_DEFAULT_INTERVAL_SECONDS,
    createdAt: now,
    expiresAt: now + lifetimeMs,
    polling: false,
  };

  getSlot().active = record;
  return record;
}

/**
 * Resolve a handle to its flow.
 *
 * An expired record is dropped as it is read: the caller answers 410 once,
 * and a client that keeps polling afterwards gets 404 instead of an endless
 * 410 from a corpse we never collected.
 */
export function resolveDeviceFlow(
  handle: string,
  now: number = Date.now()
): DeviceFlowLookup {
  const slot = getSlot();
  const record = slot.active;

  if (!record || record.handle !== handle) return { state: "unknown" };

  if (now >= record.expiresAt) {
    slot.active = null;
    return { state: "expired" };
  }

  return { state: "active", record };
}

/**
 * Raise the poll cadence after a `slow_down`. Scoped to the handle so a tick
 * that resolves late cannot re-pace a flow that has since been replaced.
 */
export function setDeviceFlowInterval(handle: string, interval: number): void {
  const record = getSlot().active;
  if (!record || record.handle !== handle) return;
  if (interval > 0) record.interval = interval;
}

/**
 * Drop the flow once it is finished — authorized, denied, expired or refused.
 *
 * Handle-scoped for the same reason as {@link setDeviceFlowInterval}: a stale
 * poll must not be able to wipe the flow the user is currently authorizing.
 */
export function forgetDeviceFlow(handle: string): void {
  const slot = getSlot();
  if (slot.active?.handle === handle) slot.active = null;
}

/** Project a record down to what may cross the wire. */
export function toClientDeviceFlow(
  record: DeviceFlowRecord,
  now: number = Date.now()
): ClientDeviceFlow {
  return {
    handle: record.handle,
    userCode: record.userCode,
    verificationUri: record.verificationUri,
    interval: record.interval,
    expiresIn: Math.max(0, Math.round((record.expiresAt - now) / 1000)),
  };
}

/**
 * Take the slot for `handle`, atomically, and consume it.
 *
 * THIS IS THE CREDENTIAL GUARD. A poll tick spends two awaits between reading
 * the slot and writing a token — one on GitHub's token endpoint, one on the
 * identity lookup — and the slot can change under either of them: a second
 * `start` supersedes the flow, the user cancels, or a manual PAT save calls
 * {@link abortDeviceFlow}. Without a re-check, a flow the user walked away
 * from minutes ago still lands its token in `settings`, silently undoing the
 * credential they saved in the meantime.
 *
 * The re-check has to be a claim rather than a read, and it has to be the last
 * thing before the write. Returning `true` means two things at once: this
 * handle still owned the slot, and nothing else can own it now — the caller
 * holds an exclusive right to persist. Node's single thread does the rest:
 * with no `await` between this call and the synchronous transaction, no other
 * request can interleave.
 *
 * Consuming on success is also what settles the flow. The authorization has
 * been spent by then whether or not the write that follows succeeds, so
 * leaving the handle resolvable would only invite a poll of a dead code.
 */
export function claimDeviceFlow(handle: string): boolean {
  const slot = getSlot();
  if (slot.active?.handle !== handle) return false;
  slot.active = null;
  return true;
}

/**
 * Mark a tick as in flight. `false` means one already is — see
 * {@link DeviceFlowRecord.polling}; the caller must answer "keep waiting"
 * without touching GitHub.
 */
export function beginDeviceFlowPoll(handle: string): boolean {
  const record = getSlot().active;
  if (!record || record.handle !== handle) return false;
  if (record.polling) return false;
  record.polling = true;
  return true;
}

/**
 * Release the in-flight marker. Handle-scoped, so a tick that resolves after
 * its flow was superseded cannot unlock the flow that replaced it.
 */
export function endDeviceFlowPoll(handle: string): void {
  const record = getSlot().active;
  if (record?.handle === handle) record.polling = false;
}

/**
 * Drop whatever flow is in the slot, whoever started it. Returns whether one
 * was actually dropped.
 *
 * Unconditional on purpose, unlike {@link forgetDeviceFlow}: the callers do
 * not hold a handle. A manual PAT save, a disconnect, or a cancel from a
 * reloaded page all mean the same thing — the user has decided how this
 * machine authenticates to GitHub, and an OAuth exchange still in flight has
 * no business overruling that decision when it lands.
 */
export function abortDeviceFlow(): boolean {
  const slot = getSlot();
  if (!slot.active) return false;
  slot.active = null;
  return true;
}

/** Test-only: empty the slot so cases cannot leak a flow into each other. */
export function _resetDeviceFlowStoreForTests(): void {
  getSlot().active = null;
}
