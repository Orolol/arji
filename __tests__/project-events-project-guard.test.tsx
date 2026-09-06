/**
 * `useProjectEvents` opens the project's SSE stream. It used to build
 * `/api/projects/${projectId}/events` with no guard on the identifier.
 *
 * An empty segment does not survive the URL parser: `/api/projects//events`
 * collapses to `/api/projects/events`, a route nothing serves. This is the
 * same defect that was fixed in `MentionTextarea` for the documents list
 * (426294c), in a hook whose consumers hand it an unresolved project:
 * `TicketOverlayProvider` passes `projectId ?? ""` down to `TicketOverlay`,
 * and both `/qa` (a finding whose owner project is unresolved) and the
 * cross-project desk (`activeProjectId` is null there) can open a ticket
 * that way.
 *
 * SSE makes it worse than a one-off 404: `EventSource` reconnects on error,
 * so the malformed request repeats on a backoff for as long as the surface
 * is mounted. The guard therefore belongs on the identifier, before the
 * connection — never on the response.
 *
 * These tests spy on the `EventSource` constructor rather than on a response,
 * because the assertion is that *no request is issued at all*.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useProjectEvents } from "@/hooks/useProjectEvents";

/** Every URL an `EventSource` was constructed with, in order. */
const constructedUrls: string[] = [];

class SpyEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    constructedUrls.push(url);
  }

  close() {
    this.closed = true;
  }
}

const originalEventSource = (globalThis as Record<string, unknown>).EventSource;

beforeEach(() => {
  constructedUrls.length = 0;
  (globalThis as Record<string, unknown>).EventSource = SpyEventSource;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).EventSource = originalEventSource;
  vi.useRealTimers();
});

describe("useProjectEvents before a project is resolved", () => {
  it("opens no stream at all when the project id is empty", () => {
    renderHook(() => useProjectEvents(""));

    expect(constructedUrls).toEqual([]);
  });

  it("opens no stream when the project id is only whitespace", () => {
    renderHook(() => useProjectEvents("   "));

    expect(constructedUrls).toEqual([]);
  });

  it("never builds a URL with an empty project segment", () => {
    renderHook(() => useProjectEvents(""));

    // Both spellings: the one written in the template, and the one the URL
    // parser actually sends after collapsing the empty segment.
    expect(constructedUrls).not.toContain("/api/projects//events");
    expect(constructedUrls).not.toContain("/api/projects/events");
  });

  it("does not tick the polling fallback while there is no project", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useProjectEvents(""));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    // A tick means "something changed, reload" to every consumer. With no
    // project there is nothing to reload, so the fallback must stay quiet.
    expect(result.current.pollTick).toBe(0);
  });

  it("reports itself disconnected rather than connecting", () => {
    const { result } = renderHook(() => useProjectEvents(""));

    // "connecting" would be a lie: nothing was ever attempted.
    expect(result.current.status).toBe("disconnected");
  });
});

describe("useProjectEvents with a resolved project", () => {
  // The controls. These pass on both sides of the fix; they are here so a
  // guard that simply disables the hook cannot look like a pass.

  it("opens exactly one stream on that project's events route", () => {
    renderHook(() => useProjectEvents("p1"));

    expect(constructedUrls).toEqual(["/api/projects/p1/events"]);
  });

  it("reconnects on the new project when the id resolves later", () => {
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useProjectEvents(projectId),
      { initialProps: { projectId: "" } },
    );

    expect(constructedUrls).toEqual([]);

    rerender({ projectId: "p1" });

    expect(constructedUrls).toEqual(["/api/projects/p1/events"]);
  });

  it("closes the stream when the project becomes unresolved again", () => {
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useProjectEvents(projectId),
      { initialProps: { projectId: "p1" } },
    );

    expect(constructedUrls).toEqual(["/api/projects/p1/events"]);

    rerender({ projectId: "" });

    // No second connection, and nothing left open on the project that went away.
    expect(constructedUrls).toEqual(["/api/projects/p1/events"]);
  });
});
