/**
 * Consuming a deep-link query parameter.
 *
 * Several screens are reached by a URL that carries an instruction rather than
 * a location — `?ticket=` from a notification, `?panel=` from the project
 * chrome, `?nightRun=` from the morning summary. The instruction is imperative
 * and one-shot, so the parameter has to leave the address bar the moment it is
 * acted on: while it is still there, closing what it opened and reloading
 * re-opens it, and back-navigation replays it.
 *
 * `router.replace()` cannot do that job. It is a *navigation*: the App Router
 * fetches the destination's RSC payload and only rewrites the address bar once
 * that round-trip commits. Measured in Chrome against a warm `next dev` on a
 * two-row project, consuming `?ticket=` that way took ~3.4s and three RSC
 * requests, and the deep link was live in the URL for every one of them.
 *
 * `window.history.replaceState` is the App Router's documented escape hatch for
 * exactly this (`next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`,
 * "Native History API"): Next patches it to dispatch `ACTION_RESTORE`, so
 * `usePathname` and `useSearchParams` stay in sync, while the URL itself is
 * rewritten synchronously and no server round-trip happens. That is the right
 * trade here because nothing on the server depends on these parameters — they
 * only ever drive client state.
 */

/** The URL `basePath` becomes once `key` is dropped from `search`. */
export function urlWithoutQueryParam(
  search: string | URLSearchParams,
  key: string,
  basePath: string,
): string {
  const next = new URLSearchParams(
    typeof search === "string" ? search : search.toString(),
  );
  next.delete(key);
  const query = next.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/**
 * Drop `key` from the address bar without navigating. Safe to call more than
 * once for the same parameter: the second call is a no-op rewrite.
 */
export function consumeQueryParam(
  search: string | URLSearchParams,
  key: string,
  basePath: string,
): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(
    null,
    "",
    urlWithoutQueryParam(search, key, basePath),
  );
}
