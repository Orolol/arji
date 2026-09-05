"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";

import {
  parseRegistryUrlState,
  registryUrlSearch,
  type RegistryUrlState,
} from "@/lib/tickets-registry/url-state";

/**
 * The registry's filters, read from and written to the address bar.
 *
 * READING is `useSearchParams()`, which the App Router keeps current through
 * every way the URL can change — a link, a chip, Back, Forward, and the
 * History API below. The screen therefore has no filter state of its own to
 * fall out of sync with the URL, which is the defect this replaces.
 *
 * WRITING is `window.history.pushState`, not `router.push()`. Both are
 * documented in `lib/navigation/deep-link.ts`, and the reasoning carries over
 * exactly: a `push()` is a NAVIGATION, so the address bar only catches up once
 * the destination's RSC payload commits — measured at ~3.4s on a warm
 * `next dev` — and nothing on the server reads these parameters anyway. Next
 * patches `pushState`/`replaceState` to dispatch `ACTION_RESTORE` "so that
 * `usePathname` and `useSearchParams` hold the pushed values"
 * (`next/dist/client/components/app-router.js`), so the rewrite is synchronous
 * and the hook above re-renders from it.
 *
 * `push`, not `replace`, because each filter set is a place the user was: Back
 * returns to the previous scope instead of leaving the screen. The no-op guard
 * keeps that history honest — re-picking the current project must not stack an
 * entry Back would have to walk through.
 *
 * Both the context and that patch belong to `<AppRouter>`. OUTSIDE the app
 * shell — a component test mounting this screen without mocking
 * `next/navigation` — `useSearchParams()` returns `null`, and the screen
 * renders its defaults rather than throwing.
 */
export interface RegistryUrlStateControls {
  filters: RegistryUrlState;
  /** Write a subset of the filters; the rest keep their current value. */
  setFilters: (patch: Partial<RegistryUrlState>) => void;
}

export function useRegistryUrlState(): RegistryUrlStateControls {
  const searchParams = useSearchParams();

  const filters = useMemo(
    () => parseRegistryUrlState(searchParams),
    [searchParams],
  );

  // Reads the live address bar rather than closing over `filters`: two writes
  // in one tick (a state pill clearing the exact status) must compose.
  const setFilters = useCallback((patch: Partial<RegistryUrlState>) => {
    const current = window.location.search;
    const next = { ...parseRegistryUrlState(current), ...patch };
    const search = registryUrlSearch(next, current);
    if (search === current) return;
    window.history.pushState(null, "", `${window.location.pathname}${search}`);
  }, []);

  return { filters, setFilters };
}
