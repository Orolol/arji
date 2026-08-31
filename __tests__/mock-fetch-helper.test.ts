/**
 * The queued fetch mock's contract (`__tests__/helpers/mock-fetch.ts`).
 *
 * The behaviour under test is the one that made
 * `__tests__/refinement-button.test.tsx` flaky: a queue that clamps its
 * index answers a component's post-dispatch status re-read with the POST
 * body it just returned. Pinning "the queue does not repeat" here means the
 * next test file to reach for this helper cannot inherit that trap.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mockFetchSequence } from "@/__tests__/helpers/mock-fetch";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

const status = { ok: true, body: { data: { running: false } } };
const posted = { ok: true, body: { data: { started: true } } };

describe("mockFetchSequence", () => {
  it("answers calls in order", async () => {
    mockFetchSequence([status, posted]);

    expect(await (await fetch("/s")).json()).toEqual(status.body);
    expect(await (await fetch("/s", { method: "POST" })).json()).toEqual(
      posted.body
    );
  });

  it("carries each response's ok flag", async () => {
    mockFetchSequence([status, { ok: false, body: { error: "nope" } }]);

    expect((await fetch("/s")).ok).toBe(true);
    expect((await fetch("/s", { method: "POST" })).ok).toBe(false);
  });

  it("refuses to answer past the end of the queue rather than repeating", async () => {
    mockFetchSequence([status, posted]);
    await fetch("/s");
    await fetch("/s", { method: "POST" });

    // The third call is the one that used to be answered with `posted` —
    // a POST payload handed back as if it were a status.
    await expect(fetch("/s")).rejects.toThrow(
      /no queued response for GET \/s \(call 3 of a 2-response queue\)/
    );
  });

  it("names the method it could not answer", async () => {
    mockFetchSequence([status]);
    await fetch("/s");

    await expect(fetch("/s", { method: "POST" })).rejects.toThrow(
      /no queued response for POST \/s/
    );
  });

  it("repeats the last response only when the caller asks for it", async () => {
    mockFetchSequence([status], { repeatLast: true });

    await fetch("/s");
    expect(await (await fetch("/s")).json()).toEqual(status.body);
    expect(await (await fetch("/s")).json()).toEqual(status.body);
  });
});
