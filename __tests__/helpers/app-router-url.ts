/**
 * The App Router's address bar, in miniature.
 *
 * `useSearchParams()` reads a React context that only the real
 * `<AppRouter>` provides, so in jsdom it is `null` and a screen whose filters
 * live in the URL has nothing to read. This helper is the smallest honest
 * stand-in: it models the two behaviours the router actually gives that hook,
 * both verified against `next/dist/client/components/app-router.js` (16.3.3).
 *
 * 1. `history.pushState` / `history.replaceState` are PATCHED — the router
 *    dispatches `ACTION_RESTORE` with the pushed URL, "so that `usePathname`
 *    and `useSearchParams` hold the pushed values". The rewrite is
 *    synchronous and costs no RSC round-trip, which is why URL-backed filters
 *    write through the History API rather than `router.replace()`.
 * 2. `popstate` — back and forward — dispatches a traverse action, so the same
 *    hooks follow the entry the browser restored. jsdom implements the session
 *    history for same-document entries, so `history.back()` here is the real
 *    thing rather than a synthesised event.
 *
 * Snapshots are cached and only replaced when the query string actually
 * changes: `useSyncExternalStore` compares by identity and would loop forever
 * on a fresh `URLSearchParams` per render.
 */
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let snapshotSearch: string | null = null;
let snapshotParams = new URLSearchParams();
let patched = false;

function syncFromLocation(): void {
  const search = window.location.search;
  if (search === snapshotSearch) return;
  snapshotSearch = search;
  snapshotParams = new URLSearchParams(search);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): URLSearchParams {
  return snapshotParams;
}

/** The `useSearchParams` stand-in — pass it to `vi.mock("next/navigation")`. */
export function useMockSearchParams(): URLSearchParams {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Patch the History API the way the App Router does and seed the address bar.
 * Call it in `beforeEach`: the patch is installed once, the URL is reset every
 * time so history entries never leak between cases.
 */
export function installAppRouterUrl(href = "/tickets"): void {
  if (!patched) {
    patched = true;
    const nativePush = window.history.pushState.bind(window.history);
    const nativeReplace = window.history.replaceState.bind(window.history);
    window.history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
      nativePush(data, unused, url ?? undefined);
      syncFromLocation();
    }) as typeof window.history.pushState;
    window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
      nativeReplace(data, unused, url ?? undefined);
      syncFromLocation();
    }) as typeof window.history.replaceState;
    window.addEventListener("popstate", syncFromLocation);
  }
  window.history.replaceState(null, "", href);
}

/** A client-side navigation to `href` — a link click, not a filter write. */
export function navigateTo(href: string): void {
  window.history.pushState(null, "", href);
}

/** What the address bar reads right now, path and query. */
export function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}
