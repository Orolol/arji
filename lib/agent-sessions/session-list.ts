/**
 * Client/server contract for the paginated unified sessions list
 * (`GET /api/projects/:projectId/sessions`).
 *
 * The route used to return every agent session of a project, unprojected, in
 * one synchronous better-sqlite3 read. Both halves of that are bounded now:
 * the route projects only the columns the UI renders, and it serves keyset
 * pages. Clients that need the whole list follow `nextCursor` through
 * `fetchUnifiedSessions` below, so the list they render is unchanged while no
 * single response — and no single query — is unbounded. A client that needs
 * ONE row — the newest one matching a predicate — uses `findUnifiedSession`,
 * which walks the same pages and stops at the one holding the answer.
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

/** Options shared by every reader of the paged list. */
export interface UnifiedSessionPagingOptions {
  /** Page size to request; the route clamps it. */
  limit?: number;
  /**
   * Aborting stops the walk: the in-flight request rejects with the fetch's
   * own `AbortError`, which propagates out of the reader, and no further page
   * is requested. A caller that owns the signal treats that rejection as its
   * own cancellation, not as a failed list.
   */
  signal?: AbortSignal;
}

export interface FetchUnifiedSessionsOptions<T> extends UnifiedSessionPagingOptions {
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
 * Walk the list one page at a time, newest first, yielding each page's rows.
 *
 * Both readers below are built on this so the loop's termination guarantees
 * live in one place: a cursor that repeats, or a page count no real project
 * can reach, throws `UnifiedSessionListIncompleteError` carrying how many rows
 * had been delivered by then. A consumer that stops iterating early simply
 * stops requesting pages — the generator holds nothing past its last `yield`.
 */
async function* pageUnifiedSessions<T>(
  projectId: string,
  { limit, signal }: UnifiedSessionPagingOptions
): AsyncGenerator<T[], void, undefined> {
  let cursor: string | null = null;
  let delivered = 0;
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
    const rows = body.data ?? [];
    delivered += rows.length;
    yield rows;

    cursor = body.nextCursor ?? null;
    if (!cursor) return;

    if (seenCursors.has(cursor)) {
      throw new UnifiedSessionListIncompleteError(
        `Sessions list cursor stopped advancing for project ${projectId}; the list is incomplete.`,
        delivered
      );
    }
    seenCursors.add(cursor);
  }

  throw new UnifiedSessionListIncompleteError(
    `Sessions list did not end after ${SESSION_LIST_MAX_PAGES} pages for project ${projectId}; the list is incomplete.`,
    delivered
  );
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
  for await (const page of pageUnifiedSessions<T>(projectId, { limit, signal })) {
    rows.push(...page);
    onPage?.(rows);
  }
  return rows;
}

/**
 * The first row in list order that satisfies `predicate` — which, because the
 * route sorts newest-first across pages, is the NEWEST such row — or `null`
 * once the whole list has been walked without one.
 *
 * Unlike `fetchUnifiedSessions`, this stops at the page holding the match:
 * the pages after it are older rows the caller has already decided not to
 * read. "No match" still costs the whole walk — only a server-side filter
 * could shorten that — and it shares its sibling's incompleteness contract: a
 * cursor that misbehaves rejects rather than answering "none".
 */
export async function findUnifiedSession<T = unknown>(
  projectId: string,
  predicate: (row: T) => boolean,
  options: UnifiedSessionPagingOptions = {}
): Promise<T | null> {
  for await (const page of pageUnifiedSessions<T>(projectId, options)) {
    const match = page.find(predicate);
    if (match !== undefined) return match;
  }
  return null;
}
