/**
 * Shared test-mock helpers for the three patterns that ~60 test files hand-roll:
 *
 *   1. The queue-based drizzle chain mock for `vi.mock("@/lib/db")`
 *      (the `select: vi.fn().mockReturnThis()` / `getQueue.shift()` block).
 *   2. The `vi.mock("@/lib/db/schema")` fake-column-map replacement
 *      (use the REAL schema — fake maps let column renames pass tests while
 *      breaking prod).
 *   3. `mockNextRequest` / `mockJsonRequest` / `mockRouteContext` factories
 *      (replace `{ json: ... } as unknown as NextRequest` and
 *      `new Request("http://localhost")` casts that fail NextRequest typing).
 *
 * This file lives in `__tests__/helpers/` on purpose: vitest's include glob is
 * `**\/*.test.{ts,tsx,mjs}`, so nothing here is collected as a test.
 *
 * =====================================================================
 * MIGRATION RECIPE (mechanical — follow in order)
 * =====================================================================
 *
 * A. Chain mock (`vi.mock("@/lib/db", ...)` with mockReturnThis chain):
 *
 *    1. Delete the hand-rolled `vi.hoisted(() => ({ getQueue: [], ... }))`
 *       state object and the whole `vi.mock("@/lib/db", () => { const chain
 *       = {...}; return { db: chain }; })` block. Replace with:
 *
 *         import { dbMockState, resetDbMockState, getDbChainMock }
 *           from "@/__tests__/helpers/db-mock";
 *
 *         vi.mock("@/lib/db", async () => {
 *           const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
 *           return dbModuleMock();
 *         });
 *
 *       (The async-import indirection keeps the factory hoist-safe even if
 *       the file statically imports the module under test.)
 *
 *    2. Map the old state fields onto `dbMockState`:
 *         getQueue                    -> dbMockState.getQueue      (unchanged)
 *         allQueue                    -> dbMockState.allQueue      (unchanged)
 *         allRows (static all() rows) -> dbMockState.allRows
 *         insertCalls/insertedValues  -> dbMockState.insertCalls
 *         updateCalls/updatedValues   -> dbMockState.updateCalls
 *       Semantics are a superset of every hand-rolled variant:
 *         get() -> getQueue.shift() ?? null
 *         all() -> allQueue.length ? allQueue.shift() : allRows (default [])
 *         insert(...).values(p) records p in insertCalls; update(...).set(p)
 *         records p in updateCalls; every builder method returns the chain,
 *         so `.returning().get()`, `.where().run()` etc. all resolve.
 *
 *    3. In `beforeEach`, replace the manual `mockDbState.x = []` lines with
 *       `resetDbMockState()` (keep `vi.clearAllMocks()` — it clears call
 *       history on the chain fns without dropping their implementations).
 *
 *    4. For assertions on specific builder calls (rare), use
 *       `getDbChainMock().insert` etc. — they are plain `vi.fn`s.
 *
 * B. Schema mock (`vi.mock("@/lib/db/schema", () => ({ table: { col: "col",
 *    ... } }))` fake column maps):
 *
 *    1. PREFERRED: just DELETE the whole `vi.mock("@/lib/db/schema", ...)`
 *       block. `lib/db/schema.ts` is side-effect-free; the real tables work
 *       with the chain mock (where()/values() ignore their arguments) and a
 *       column rename now breaks the test like it breaks prod.
 *    2. The real schema evaluates `sql\`...\`` from "drizzle-orm" at module
 *       load. If the file also has `vi.mock("drizzle-orm", ...)`, delete
 *       that too — real `eq`/`and`/`desc`/`sql` are pure builders and work
 *       fine against the chain mock. (If you must keep a drizzle-orm mock,
 *       it MUST export a tagged-template-safe `sql`, or schema eval throws.)
 *    3. Only if the test genuinely needs to override ONE schema export
 *       (almost never — grep first for why), keep the mock but spread the
 *       real module so every other table stays real:
 *
 *         vi.mock("@/lib/db/schema", async () => {
 *           const { actualDbSchema } = await import("@/__tests__/helpers/db-mock");
 *           return { ...(await actualDbSchema()), theOneOverride: fake };
 *         });
 *
 * C. Request factories:
 *
 *    1. `{ json: () => Promise.resolve(body) } as unknown as NextRequest`
 *         -> `mockJsonRequest(body)`
 *    2. `new Request("http://localhost")` passed to a NextRequest handler
 *         -> `mockNextRequest()` (add `{ method: "DELETE" }` etc. if the
 *            handler reads it)
 *    3. `{ params: Promise.resolve({ id }) }` second args
 *         -> `mockRouteContext({ id })`
 *    Handlers that read formData() from a hand-rolled fake can keep their
 *    local fake (real FormData/File encoding is a behavior change — do not
 *    convert those blindly).
 *
 * D. Run `npx vitest run <file>` after each conversion. Zero behavior change
 *    expected; if a test starts failing, the old mock was hiding a real
 *    mismatch — stop and investigate, do not paper over it.
 *
 * =====================================================================
 * KNOWN LIMITATION: `vi.resetModules()`
 * =====================================================================
 * Files that call `vi.resetModules()` in `beforeEach` are generally NOT
 * convertible to this helper (two conversions were reverted over this:
 * agent-launch-concurrency-routes, process-manager). `resetModules()`
 * re-evaluates this helper for the test file's static import, but the
 * `vi.mock("@/lib/db")` factory's `await import(...)` may resolve a
 * DIFFERENT module generation — so the chain reads a `dbMockState` the
 * test no longer holds (seeds silently vanish), or the mock detaches and
 * the real `@/lib/db` opens `data/arij.db`. If stuck with such a file,
 * either keep its hand-rolled hoisted mock, or hold all shared state in
 * `vi.hoisted(...)` (hoisted state survives module resets — see
 * epic-build-concurrency.test.ts for a working example).
 * =====================================================================
 */
import { vi } from "vitest";
import { NextRequest } from "next/server";

/* ------------------------------------------------------------------ */
/* 1. Queue-based drizzle chain mock                                   */
/* ------------------------------------------------------------------ */

export interface DbMockState {
  /** Results returned (shifted) by each `.get()` call; `null` when empty. */
  getQueue: unknown[];
  /** Results returned (shifted) by each `.all()` call; falls back to allRows. */
  allQueue: unknown[];
  /** Static fallback for `.all()` when allQueue is empty (default `[]`). */
  allRows: unknown[];
  /** Payloads passed to `insert(...).values(payload)`. */
  insertCalls: unknown[];
  /** Payloads passed to `update(...).set(payload)`. */
  updateCalls: unknown[];
  /** Result returned by `.run()`. */
  runResult: { changes: number };
}

function emptyState(): DbMockState {
  return {
    getQueue: [],
    allQueue: [],
    allRows: [],
    insertCalls: [],
    updateCalls: [],
    runResult: { changes: 1 },
  };
}

/**
 * Per-test-file singleton state (each vitest file gets its own module graph,
 * so this is NOT shared across files). Seed queues in tests, reset in
 * beforeEach via `resetDbMockState()`.
 */
export const dbMockState: DbMockState = emptyState();

/** Reset the singleton (or a custom state object) between tests. */
export function resetDbMockState(state: DbMockState = dbMockState): void {
  Object.assign(state, emptyState());
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type DrizzleChainMock = Record<string, ReturnType<typeof vi.fn>> & any;

/**
 * Builds the fluent chain: every builder method returns the chain itself,
 * terminals consult `state`. Superset of the hand-rolled shapes, so
 * `db.select().from().where().get()`, `db.insert(t).values(p).run()`,
 * `db.update(t).set(p).where().run()`, `db.delete(t).where().run()` and
 * `.returning().get()` all work.
 */
export function createDrizzleChainMock(
  state: DbMockState = dbMockState
): DrizzleChainMock {
  const chain: DrizzleChainMock = {};

  const passthrough = [
    "select",
    "selectDistinct",
    "from",
    "where",
    "orderBy",
    "limit",
    "offset",
    "groupBy",
    // `.as(alias)` — a subquery handle. Passthrough is enough here: the fake
    // has no columns, so what matters is that the chain keeps flowing and the
    // terminal `.all()` still consumes exactly one queued result.
    "as",
    "leftJoin",
    "innerJoin",
    "insert",
    "update",
    "delete",
    "returning",
    "onConflictDoNothing",
    "onConflictDoUpdate",
  ] as const;
  for (const method of passthrough) {
    chain[method] = vi.fn(() => chain);
  }

  chain.values = vi.fn((payload: unknown) => {
    state.insertCalls.push(payload);
    return chain;
  });
  chain.set = vi.fn((payload: unknown) => {
    state.updateCalls.push(payload);
    return chain;
  });

  chain.get = vi.fn(() => state.getQueue.shift() ?? null);
  chain.all = vi.fn(() =>
    state.allQueue.length > 0 ? state.allQueue.shift() : state.allRows
  );
  chain.run = vi.fn(() => state.runResult);
  chain.transaction = vi.fn((fn: (tx: DrizzleChainMock) => unknown) =>
    fn(chain)
  );

  return chain;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let singletonChain: DrizzleChainMock | null = null;

/** The chain instance `dbModuleMock()` hands to `vi.mock("@/lib/db")`. */
export function getDbChainMock(): DrizzleChainMock {
  if (!singletonChain) {
    singletonChain = createDrizzleChainMock(dbMockState);
  }
  return singletonChain;
}

/**
 * Drop-in module factory for `vi.mock("@/lib/db", ...)`. Mirrors the real
 * module's exports (`db`, `sqlite`, `ensureDbReady`).
 */
export function dbModuleMock(): {
  db: DrizzleChainMock;
  sqlite: Record<string, never>;
  ensureDbReady: ReturnType<typeof vi.fn>;
} {
  return {
    db: getDbChainMock(),
    sqlite: {},
    ensureDbReady: vi.fn(),
  };
}

/* ------------------------------------------------------------------ */
/* 2. REAL-schema passthrough                                          */
/* ------------------------------------------------------------------ */

/**
 * The actual `@/lib/db/schema` module, bypassing any `vi.mock` on it.
 *
 * Prefer deleting the schema mock entirely (the module is side-effect-free).
 * Use this only when a test must override a single export while keeping the
 * rest real — see recipe section B.3 in the header. Hand-written fake column
 * maps are banned: they let schema renames pass tests while breaking prod.
 */
export async function actualDbSchema(): Promise<
  typeof import("@/lib/db/schema")
> {
  return vi.importActual<typeof import("@/lib/db/schema")>("@/lib/db/schema");
}

/* ------------------------------------------------------------------ */
/* 3. NextRequest factories                                            */
/* ------------------------------------------------------------------ */

export interface MockRequestInit {
  /** Absolute URL; defaults to http://localhost:3000/api/test */
  url?: string;
  /** Defaults to POST when a body is provided, GET otherwise. */
  method?: string;
  headers?: Record<string, string>;
  /** JSON-stringified unless it is already a string. */
  body?: unknown;
  searchParams?: Record<string, string>;
}

/**
 * A REAL NextRequest (no `as unknown as NextRequest` casts, no tsc noise).
 */
export function mockNextRequest(init: MockRequestInit = {}): NextRequest {
  const url = new URL(init.url ?? "http://localhost:3000/api/test");
  for (const [key, value] of Object.entries(init.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const hasBody = init.body !== undefined;
  const rawBody =
    typeof init.body === "string" ? init.body : JSON.stringify(init.body);

  return new NextRequest(url, {
    method: init.method ?? (hasBody ? "POST" : "GET"),
    headers: hasBody
      ? { "content-type": "application/json", ...init.headers }
      : init.headers,
    body: hasBody ? rawBody : undefined,
  });
}

/** Shorthand for the dominant `{ json: () => Promise.resolve(body) }` fake. */
export function mockJsonRequest(
  body: unknown,
  init: Omit<MockRequestInit, "body"> = {}
): NextRequest {
  return mockNextRequest({ ...init, body });
}

/** Second argument for App Router handlers: `{ params: Promise<P> }`. */
export function mockRouteContext<P extends Record<string, string>>(
  params: P
): { params: Promise<P> } {
  return { params: Promise.resolve(params) };
}
