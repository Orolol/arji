/**
 * Client/server contract for the paginated unified sessions list
 * (`GET /api/projects/:projectId/sessions`).
 *
 * The route used to return every agent session of a project, unprojected, in
 * one synchronous better-sqlite3 read. Both halves of that are bounded now:
 * the route projects only the columns the UI renders, and it serves keyset
 * pages. Clients that need the whole list follow `nextCursor` through
 * `fetchUnifiedSessions` below, so the list they render is unchanged while no
 * single response — and no single query — is unbounded.
 */

/** Page size when the caller does not ask for one. */
export const SESSION_LIST_DEFAULT_PAGE_SIZE = 200;

/** Ceiling for an explicit `?limit=`; keeps one request from unbounding again. */
export const SESSION_LIST_MAX_PAGE_SIZE = 1000;

/**
 * Runaway guard for the follow-the-cursor loop. At the default page size this
 * is 5000 sessions — far past any real project, and a cheap way to make sure a
 * bad `nextCursor` can never spin the browser forever.
 */
export const SESSION_LIST_MAX_PAGES = 25;

/** One page as the route returns it. */
export interface UnifiedSessionListPage<T = unknown> {
  data: T[];
  nextCursor?: string | null;
}

export interface FetchUnifiedSessionsOptions<T> {
  /** Page size to request; the route clamps it. */
  limit?: number;
  signal?: AbortSignal;
  /**
   * Called after each page with everything fetched so far, so a list can
   * paint the newest sessions before the tail arrives.
   */
  onPage?: (rowsSoFar: T[]) => void;
}

/**
 * Fetch the complete unified session list, page by page. Rejects on a failed
 * response so callers keep whatever they were showing rather than replacing
 * it with a truncated list.
 */
export async function fetchUnifiedSessions<T = unknown>(
  projectId: string,
  options: FetchUnifiedSessionsOptions<T> = {}
): Promise<T[]> {
  const { limit, signal, onPage } = options;
  const rows: T[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < SESSION_LIST_MAX_PAGES; page++) {
    const url = new URL(
      `/api/projects/${projectId}/sessions`,
      window.location.origin
    );
    if (limit !== undefined) url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url.toString(), { signal });
    if (!response.ok) {
      throw new Error(`Sessions list request failed (${response.status})`);
    }

    const body = (await response.json()) as UnifiedSessionListPage<T>;
    rows.push(...(body.data ?? []));
    onPage?.(rows);

    cursor = body.nextCursor ?? null;
    if (!cursor) return rows;
  }

  // Never silently: the caller is showing a truncated list from here on.
  console.warn(
    `[sessions] stopped after ${SESSION_LIST_MAX_PAGES} pages for project ${projectId}; the list is truncated.`
  );
  return rows;
}
