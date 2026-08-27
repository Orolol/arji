/**
 * `SessionOutputStream` — the client half of the paginated session detail.
 *
 * The route now ships only a short preview of each stream (the whole thing
 * was 112 MB for the worst session on the live database). That moves a
 * requirement onto the client: the rest of the output must stay REACHABLE,
 * one bounded page at a time, and the page must not stall while it walks.
 *
 * What these pin:
 * - the seeded preview paints with no request at all — opening the tab costs
 *   nothing beyond the detail payload that already arrived;
 * - "Load more" advances the cursor and APPENDS, so following it to the end
 *   yields the stream exactly once;
 * - a running session tails itself from its own moving cursor, and the 3s
 *   detail poll re-sending its preview does not reset that cursor;
 * - a chunk-read failure says so, and is never rendered as "no output".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  SessionOutputStream,
  type SessionStreamSeed,
} from "@/components/sessions/SessionOutputStream";
import type { BoundedSessionChunk } from "@/lib/agent-sessions/chunks";

const originalFetch = global.fetch;

function chunk(sequence: number, content: string): BoundedSessionChunk {
  return {
    id: `c${sequence}`,
    sessionId: "sess-1",
    streamType: "raw",
    sequence,
    chunkKey: null,
    content,
    createdAt: "2026-08-27T10:00:00.000Z",
    contentLength: content.length,
    contentTruncated: false,
    contentOffset: 0,
  };
}

function seed(
  chunks: BoundedSessionChunk[],
  hasMore: boolean
): SessionStreamSeed {
  return {
    chunks,
    nextAfter: chunks.length > 0 ? chunks[chunks.length - 1].sequence : null,
    hasMore,
  };
}

/** Queue of stream pages, consumed in order; the last one repeats. */
function mockPages(pages: Array<Partial<Record<string, unknown>>>) {
  let index = 0;
  const fetchMock = vi.fn(async (input: string | URL) => {
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return {
      ok: true,
      json: async () => ({ data: { sessionId: "sess-1", streamType: "raw", ...page } }),
      url: String(input),
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

function renderStream(props: Partial<React.ComponentProps<typeof SessionOutputStream>> = {}) {
  return render(
    <SessionOutputStream
      projectId="proj-1"
      sessionId="sess-1"
      streamType="raw"
      seed={seed([chunk(1, "alpha "), chunk(2, "beta")], true)}
      isRunning={false}
      emptyLabel="No logs available"
      {...props}
    />
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("the seeded preview", () => {
  it("paints from the detail payload without issuing a request", () => {
    const fetchMock = mockPages([{ chunks: [], nextAfter: 2, hasMore: false }]);

    renderStream();

    expect(screen.getByTestId("stream-raw")).toHaveTextContent("alpha beta");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("offers no 'load more' when the seed already holds the whole stream", () => {
    mockPages([]);
    renderStream({ seed: seed([chunk(1, "only")], false) });

    expect(screen.queryByTestId("stream-load-more-raw")).not.toBeInTheDocument();
  });

  it("falls back to the legacy logs.json text when the stream is empty", () => {
    mockPages([]);
    renderStream({
      seed: seed([], false),
      fallback: <p>legacy logs body</p>,
    });

    expect(screen.getByText("legacy logs body")).toBeInTheDocument();
    expect(screen.queryByText("No logs available")).not.toBeInTheDocument();
  });

  it("says the session produced nothing when there is no fallback either", () => {
    mockPages([]);
    renderStream({ seed: seed([], false) });

    expect(screen.getByText("No logs available")).toBeInTheDocument();
  });
});

describe("walking the stream forward", () => {
  it("asks from the seed's cursor and appends the page", async () => {
    const fetchMock = mockPages([
      { chunks: [chunk(3, " gamma")], nextAfter: 3, hasMore: false },
    ]);

    renderStream();
    fireEvent.click(screen.getByTestId("stream-load-more-raw"));

    await waitFor(() => {
      expect(screen.getByTestId("stream-raw")).toHaveTextContent(
        "alpha beta gamma"
      );
    });
    const url = requestedUrls(fetchMock)[0];
    expect(url).toContain("stream=raw");
    // From where the preview stopped — not from the beginning of the stream.
    expect(url).toContain("after=2");
    // Exhausted: the affordance retires rather than looping on a dead cursor.
    expect(screen.queryByTestId("stream-load-more-raw")).not.toBeInTheDocument();
  });

  it("delivers the stream exactly once across several pages", async () => {
    const fetchMock = mockPages([
      { chunks: [chunk(3, "C")], nextAfter: 3, hasMore: true },
      { chunks: [chunk(4, "D")], nextAfter: 4, hasMore: true },
      { chunks: [chunk(5, "E")], nextAfter: 5, hasMore: false },
    ]);

    renderStream({ seed: seed([chunk(1, "A"), chunk(2, "B")], true) });

    for (let click = 0; click < 3; click++) {
      fireEvent.click(await screen.findByTestId("stream-load-more-raw"));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(click + 1));
    }

    await waitFor(() => {
      expect(screen.getByTestId("stream-raw")).toHaveTextContent("ABCDE");
    });
    expect(requestedUrls(fetchMock).map((url) => new URL(url).searchParams.get("after")))
      .toEqual(["2", "3", "4"]);
  });

  it("surfaces a failed page instead of silently stopping", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    renderStream();
    fireEvent.click(screen.getByTestId("stream-load-more-raw"));

    expect(await screen.findByText("Could not load more output.")).toBeInTheDocument();
    // The affordance survives the failure — the output is still reachable.
    expect(screen.getByTestId("stream-load-more-raw")).toBeInTheDocument();
  });
});

describe("a running session tails itself", () => {
  it("appends each poll from its own moving cursor", async () => {
    vi.useFakeTimers();
    const fetchMock = mockPages([
      { chunks: [chunk(3, "C")], nextAfter: 3, hasMore: false },
      { chunks: [chunk(4, "D")], nextAfter: 4, hasMore: false },
    ]);

    renderStream({
      seed: seed([chunk(1, "A"), chunk(2, "B")], false),
      isRunning: true,
    });

    // `immediate: false` — a running stream waits one interval before its
    // first tail, so the seed is not re-fetched on mount.
    expect(fetchMock).not.toHaveBeenCalled();

    // Each tick both fires the poll and flushes the state update it causes,
    // so the second tick reads the cursor the first one moved.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(requestedUrls(fetchMock).map((url) => new URL(url).searchParams.get("after")))
      .toEqual(["2", "3"]);
    expect(screen.getByTestId("stream-raw")).toHaveTextContent("ABCD");
  });

  it("does not poll a finished session", async () => {
    vi.useFakeTimers();
    const fetchMock = mockPages([{ chunks: [], nextAfter: 2, hasMore: false }]);

    renderStream({ isRunning: false });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a chunk-read failure is visible, not silent", () => {
  it("names the damaged record rather than showing the empty-output label", () => {
    mockPages([]);
    renderStream({ unavailable: true, seed: null });

    expect(screen.getByTestId("stream-unavailable-raw")).toBeInTheDocument();
    // The distinction the ticket asks for: this is NOT "no output".
    expect(screen.queryByText("No logs available")).not.toBeInTheDocument();
  });

  it("does not poll a stream the route cannot read", async () => {
    vi.useFakeTimers();
    const fetchMock = mockPages([]);

    renderStream({ unavailable: true, seed: null, isRunning: true });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a stream that goes unreadable mid-walk", async () => {
    mockPages([
      { chunks: [], nextAfter: 2, hasMore: false, chunkStreamsUnavailable: true },
    ]);

    renderStream();
    fireEvent.click(screen.getByTestId("stream-load-more-raw"));

    expect(
      await screen.findByText("This session's output could not be read.")
    ).toBeInTheDocument();
  });
});

describe("oversized chunks", () => {
  it("says how many are shown only in part", () => {
    mockPages([]);
    const big = { ...chunk(1, "prefix"), contentLength: 8_300_000, contentTruncated: true };
    renderStream({ seed: seed([big], false) });

    expect(screen.getByTestId("stream-truncated-raw")).toHaveTextContent(
      "One oversized chunk is shown in part."
    );
  });

  it("counts several of them", () => {
    mockPages([]);
    const a = { ...chunk(1, "a"), contentTruncated: true };
    const b = { ...chunk(2, "b"), contentTruncated: true };
    renderStream({ seed: seed([a, b], false) });

    expect(screen.getByTestId("stream-truncated-raw")).toHaveTextContent(
      "2 oversized chunks are shown in part."
    );
  });
});
