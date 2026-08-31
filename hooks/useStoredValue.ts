"use client";

import { useSyncExternalStore } from "react";

/**
 * localStorage as a React external store.
 *
 * The house pattern for per-project UI preferences (`arij.*.<projectId>` keys)
 * used to be a pair of effects: one reading the key on mount into state, one
 * writing the state back on change. That mirrors the same value in two places,
 * renders the default for one commit before correcting it, and updates state
 * synchronously from an effect body.
 *
 * Subscribing to localStorage instead makes it the single owner of the value.
 * `getServerSnapshot` returns `null`, so the server HTML and the hydrating
 * client render the same thing and React swaps in the stored value only after
 * hydration — no mismatch, and no flash of the default.
 *
 * The snapshot is the **raw string**, deliberately: `useSyncExternalStore`
 * compares snapshots with `Object.is`, so returning a freshly parsed object
 * every call would re-render forever. Parse the raw value with `useMemo` (or a
 * plain comparison for booleans) at the call site.
 */

const listeners = new Set<() => void>();

function subscribeToStoredValue(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readStoredValue(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private mode / blocked storage — behave as if nothing was stored.
    return null;
  }
}

const noStoredValue = () => null;

/** Write `key` and notify this tab; `storage` events only reach *other* tabs. */
export function writeStoredValue(key: string, value: string) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage write failures
  }
  for (const listener of listeners) listener();
}

/** The current raw string stored at `key`, or null when unset. */
export function useStoredValue(key: string): string | null {
  return useSyncExternalStore(
    subscribeToStoredValue,
    () => readStoredValue(key),
    noStoredValue,
  );
}
