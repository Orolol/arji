/**
 * Queued `global.fetch` mock for component tests.
 *
 * The contract that matters — and the reason this exists as one shared
 * helper rather than a copy per test file — is what happens when the queue
 * runs out. The obvious implementation clamps the index and lets the final
 * response answer every later call, which is silently wrong for any
 * component that polls: the last queued response is typically the answer to
 * a POST, and a component re-reading its status then gets that POST body
 * back as if it were a status. `running` is missing from it, which reads as
 * "the pass ended" — the state collapses and the test races its own mock.
 * That is exactly how `__tests__/refinement-button.test.tsx` became flaky.
 *
 * So the queue does not repeat. A call past the end throws, naming the
 * request it could not answer, and a test that genuinely wants a steady
 * state says so with `{ repeatLast: true }` — a poll cadence test wants
 * every tick answered, and that is a deliberate choice, not a fallback.
 *
 * This file lives in `__tests__/helpers/`: vitest's include glob is
 * `**\/*.test.{ts,tsx,mjs}`, so nothing here is collected as a test.
 */

import { vi } from "vitest";

export interface QueuedResponse {
  ok: boolean;
  /** Whatever `response.json()` should resolve to. */
  body: unknown;
}

export interface MockFetchSequenceOptions {
  /**
   * Let the final response answer every call past the end of the queue.
   * Off by default — see the note above.
   */
  repeatLast?: boolean;
}

/** `GET /url` for the exhausted-queue message. */
function describeRequest(input: unknown, init?: { method?: string }): string {
  return `${init?.method ?? "GET"} ${String(input)}`;
}

/**
 * Installs a `global.fetch` that answers with `responses` in order and
 * returns the mock. Restoring the real `fetch` is the caller's job — the
 * test files that use this keep the original in an `afterEach`.
 */
export function mockFetchSequence(
  responses: ReadonlyArray<QueuedResponse>,
  { repeatLast = false }: MockFetchSequenceOptions = {}
) {
  let index = 0;
  const fetchMock = vi.fn(async (input?: unknown, init?: { method?: string }) => {
    const call = index++;
    const queued =
      responses[
        repeatLast ? Math.min(call, responses.length - 1) : call
      ];
    if (!queued) {
      throw new Error(
        `fetch mock: no queued response for ${describeRequest(input, init)} ` +
          `(call ${call + 1} of a ${responses.length}-response queue). ` +
          `Queue the response this call expects, or pass ` +
          `{ repeatLast: true } if the last response really is a steady state.`
      );
    }
    return {
      ok: queued.ok,
      json: async () => queued.body,
    } as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}
