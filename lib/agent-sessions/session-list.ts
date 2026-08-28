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
 * Characters of `agent_sessions.error` the list serves per row.
 *
 * A row count is not a byte bound while a row can carry an unbounded column.
 * A terminal error is deliberately durable and complete — the detail route
 * still serves all of it — but the list only ever paints it as one
 * CSS-truncated line, so a single pathological failure must not be able to
 * push a page past its budget on its own. Cut in SQL with `substr`, so the
 * value never crosses into the process whole.
 */
export const SESSION_LIST_ERROR_PREVIEW_CHARS = 400;

/**
 * Last-resort ceiling on the follow-the-cursor loop, for a server that keeps
 * inventing fresh cursors forever. Deliberately far past any real project:
 * the loop's actual termination guarantee is the cursor-cycle check in
 * `fetchUnifiedSessions`, not a page count. Reaching this is a bug, and it is
 * reported as one — never as a completed list.
 */
export const SESSION_LIST_MAX_PAGES = 10_000;

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
 * Raised when the page loop cannot reach the end of the list. Callers must
 * treat whatever they collected as incomplete: it is a prefix of the list, not
 * the list. Never thrown for an ordinary long list — only for a cursor that
 * stops advancing or a page count no real project can reach.
 */
export class UnifiedSessionListIncompleteError extends Error {
  /** Rows delivered before the loop gave up — a prefix, never the whole list. */
  readonly partialRowCount: number;

  constructor(message: string, partialRowCount: number) {
    super(message);
    this.name = "UnifiedSessionListIncompleteError";
    this.partialRowCount = partialRowCount;
  }
}

/**
 * Fetch the complete unified session list, page by page.
 *
 * Every return from this function is the WHOLE list. A response that cannot
 * be completed rejects instead — with `UnifiedSessionListIncompleteError` when
 * the cursor misbehaves, or the underlying fetch error otherwise — so no
 * caller can mistake a prefix for the list. That matters beyond the Sessions
 * page: `selectLatestFailures` is a "newest session per epic wins" verdict, so
 * a missing tail turns into a wrong badge rather than a missing one.
 */
export async function fetchUnifiedSessions<T = unknown>(
  projectId: string,
  options: FetchUnifiedSessionsOptions<T> = {}
): Promise<T[]> {
  const { limit, signal, onPage } = options;
  const rows: T[] = [];
  let cursor: string | null = null;
  // The cursor is the sort key of the last row already delivered, so a
  // well-behaved server never repeats one. Seeing a repeat means the list is
  // not advancing, and following it again would loop forever.
  const seenCursors = new Set<string>();

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

    if (seenCursors.has(cursor)) {
      throw new UnifiedSessionListIncompleteError(
        `Sessions list cursor stopped advancing for project ${projectId}; the list is incomplete.`,
        rows.length
      );
    }
    seenCursors.add(cursor);
  }

  throw new UnifiedSessionListIncompleteError(
    `Sessions list did not end after ${SESSION_LIST_MAX_PAGES} pages for project ${projectId}; the list is incomplete.`,
    rows.length
  );
}
