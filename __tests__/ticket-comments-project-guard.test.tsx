/**
 * `useTicketComments` is the sibling recorded alongside the `useProjectEvents`
 * defect: it builds the comment-thread URL from `projectId` with no guard on
 * that identifier. The epic branch is gated on `epicId`, which says nothing
 * about the project, and the story branch is gated on nothing at all.
 *
 * The failure mode is the same URL collapse: `/api/projects//stories/s1/
 * comments` becomes `/api/projects/stories/s1/comments`, a route nothing
 * serves — and this one polls every 5 seconds, so the 404 repeats.
 *
 * The guard is on the identifier, before the request. The assertions are
 * therefore about which URLs were asked for, not about how a 404 was handled.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useTicketComments } from "@/hooks/useTicketComments";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: [] }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

/** Every URL the hook asked for, in order. */
function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe("useTicketComments before a project is resolved", () => {
  it("asks for no story thread while the project id is empty", async () => {
    renderHook(() =>
      useTicketComments("", { kind: "story", storyId: "s1" }),
    );

    await act(async () => {});

    expect(requestedUrls()).toEqual([]);
  });

  it("asks for no epic thread while the project id is empty", async () => {
    renderHook(() =>
      useTicketComments("", { kind: "epic", epicId: "e1" }),
    );

    await act(async () => {});

    expect(requestedUrls()).toEqual([]);
  });

  it("treats a whitespace-only project id as unresolved", async () => {
    renderHook(() =>
      useTicketComments("   ", { kind: "story", storyId: "s1" }),
    );

    await act(async () => {});

    expect(requestedUrls()).toEqual([]);
  });

  it("never builds a URL with an empty project segment", async () => {
    renderHook(() =>
      useTicketComments("", { kind: "story", storyId: "s1" }),
    );

    await act(async () => {});

    const urls = requestedUrls();
    expect(urls).not.toContain("/api/projects//stories/s1/comments");
    expect(urls).not.toContain("/api/projects/stories/s1/comments");
  });

  it("settles as an empty, non-loading thread", async () => {
    const { result } = renderHook(() =>
      useTicketComments("", { kind: "story", storyId: "s1" }),
    );

    await act(async () => {});

    expect(result.current.comments).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("posts nothing when addComment runs without a project", async () => {
    const { result } = renderHook(() =>
      useTicketComments("", { kind: "story", storyId: "s1" }),
    );

    await act(async () => {
      await result.current.addComment("hello");
    });

    expect(requestedUrls()).toEqual([]);
  });
});

describe("useTicketComments with a resolved project", () => {
  // The controls: they pass on both sides of the fix, so a guard that simply
  // switched the hook off would not look like a pass.

  it("loads that project's story thread", async () => {
    renderHook(() =>
      useTicketComments("p1", { kind: "story", storyId: "s1" }),
    );

    await waitFor(() => {
      expect(requestedUrls()).toContain("/api/projects/p1/stories/s1/comments");
    });
  });

  it("loads that project's epic thread", async () => {
    renderHook(() =>
      useTicketComments("p1", { kind: "epic", epicId: "e1" }),
    );

    await waitFor(() => {
      expect(requestedUrls()).toContain("/api/projects/p1/epics/e1/comments");
    });
  });

  it("still resolves an epic target with no epic id to an empty thread", async () => {
    const { result } = renderHook(() =>
      useTicketComments("p1", { kind: "epic", epicId: null }),
    );

    await act(async () => {});

    expect(requestedUrls()).toEqual([]);
    expect(result.current.comments).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});
