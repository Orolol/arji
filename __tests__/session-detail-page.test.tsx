/**
 * The live-session screen (frame 8a).
 *
 * These are behavioural assertions, not structural ones: the previous version
 * of this file pinned Radix tab roles, badge text and a `.max-h-[500px]`
 * class, all of which the redesign removed. What survives — and what matters —
 * is that the page still fetches the way it must (the prompt lazily, the
 * Arij-actions scan separately), still shows every fact about the run, and
 * still refuses to print a zero where it has no number.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

vi.mock("next/navigation", () => ({
  useParams: () => ({
    projectId: "proj-1",
    sessionId: "sess-1",
  }),
  useRouter: () => ({
    push: vi.fn(),
    back: vi.fn(),
  }),
}));

import SessionDetailPage from "@/app/projects/[projectId]/sessions/[sessionId]/page";
import {
  chunkElisionMarker,
  SESSION_CHUNK_ELISION_LABEL,
} from "@/lib/agent-sessions/chunk-cap";
import {
  chunkPruneMarker,
  SESSION_CHUNK_PRUNE_LABEL,
} from "@/lib/agent-sessions/chunk-retention";

const mockSession = {
  id: "sess-12345678",
  status: "completed",
  mode: "code",
  provider: "claude-code",
  agentType: "build",
  epicId: "epic-1",
  branchName: "feature/test",
  worktreePath: "/tmp/.arij-worktrees/arj-122",
  startedAt: new Date(Date.now() - 60000).toISOString(),
  completedAt: new Date().toISOString(),
  createdAt: new Date(Date.now() - 120000).toISOString(),
  lastNonEmptyText: "All tests passed.",
  outcome: "answered",
  error: null,
  totalCostUsd: 0.84,
  logs: {
    success: true,
    result:
      "Feature implemented successfully.\n\nAll tests passed.\nBuild succeeded.",
    duration: 60000,
  },
};

const mockFiles = {
  sessionId: "sess-1",
  ticket: {
    id: "epic-1",
    readableId: "ARJ-122",
    title: "Streaming session logs over SSE",
  },
  project: { id: "proj-1", name: "Arij" },
  diff: {
    available: true,
    branchName: "feature/test",
    baseBranch: "main",
    mergeBase: "e4f21c9aaa",
    behind: 0,
    ahead: 3,
    files: [
      {
        path: "lib/sse/stream.ts",
        added: 142,
        removed: 18,
        inProgress: false,
      },
    ],
    totals: { files: 1, added: 142, removed: 18 },
    truncated: false,
  },
};

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
  };
}

/**
 * The screen talks to three URL shapes plus the lazy prompt. Keying the mock
 * on the URL is what makes the "the prompt was never fetched" assertion
 * meaningful.
 */
function installFetch({
  session = mockSession,
  files = mockFiles,
  actions = [] as unknown[],
}: {
  session?: Record<string, unknown>;
  files?: unknown;
  actions?: unknown[];
} = {}) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes("include=prompt")) {
      return Promise.resolve(
        jsonResponse({ data: { ...session, prompt: "THE EXACT PROMPT" } })
      );
    }
    if (url.includes("view=arij-actions")) {
      return Promise.resolve(
        jsonResponse({
          data: { sessionId: "sess-1", actions, hasMore: false },
        })
      );
    }
    if (url.includes("/files")) {
      return Promise.resolve(jsonResponse({ data: files }));
    }
    return Promise.resolve(jsonResponse({ data: session }));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof installFetch>, needle: string) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes(needle));
}

beforeEach(() => {
  installFetch();
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("live session — header identity", () => {
  it("shows the project chip, ticket chip, state stamp and ticket title", async () => {
    installFetch({ session: { ...mockSession, status: "running" } });
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("ARJ-122")).toBeInTheDocument();
    });

    expect(screen.getByText("ARIJ")).toBeInTheDocument();
    expect(
      screen.getByText("Streaming session logs over SSE")
    ).toBeInTheDocument();
    expect(screen.getByText("LIVE · BUILD")).toBeInTheDocument();
  });

  it("changes the stamp WORD with the status, never inventing a colour role", async () => {
    for (const [status, word, tone] of [
      ["completed", "DONE · BUILD", "land"],
      ["failed", "FAILED · BUILD", "failed"],
      ["queued", "QUEUED · BUILD", "next"],
    ] as const) {
      installFetch({ session: { ...mockSession, status, error: null } });
      const { unmount } = render(<SessionDetailPage />);

      const stamp = await screen.findByText(word);
      expect(stamp.closest("[data-slot='stamp']")).toHaveAttribute(
        "data-tone",
        tone
      );
      unmount();
    }
  });

  it("renders Stop session while running or queued, and not once completed", async () => {
    installFetch({ session: { ...mockSession, status: "running" } });
    const running = render(<SessionDetailPage />);
    expect(await screen.findByText("Stop session")).toBeInTheDocument();
    running.unmount();

    installFetch({ session: { ...mockSession, status: "queued" } });
    const queued = render(<SessionDetailPage />);
    expect(await screen.findByText("Stop session")).toBeInTheDocument();
    queued.unmount();

    installFetch();
    render(<SessionDetailPage />);
    await screen.findByText("Session");
    expect(screen.queryByText("Stop session")).not.toBeInTheDocument();
  });

  it("renders an em-dash for an unknown cost, never $0.00", async () => {
    installFetch({ session: { ...mockSession, totalCostUsd: null } });
    render(<SessionDetailPage />);

    await screen.findByText("Session");
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("marks a running session's cost as live", async () => {
    installFetch({
      session: { ...mockSession, status: "running", totalCostUsd: 0.84 },
    });
    render(<SessionDetailPage />);

    // The frame draws "$0.84"; the shared formatter gives sub-dollar costs
    // three decimals on purpose ("agent runs routinely cost cents"), and it is
    // not forked for a screen.
    expect(await screen.findByText("$0.840 live")).toBeInTheDocument();
  });
});

describe("live session — the log is the screen", () => {
  it("renders the raw stream inside the terminal card", async () => {
    installFetch({
      session: {
        ...mockSession,
        status: "running",
        chunkStreams: {
          raw: {
            chunks: [
              {
                id: "chunk-1",
                sessionId: "sess-1",
                streamType: "raw",
                sequence: 1,
                chunkKey: "stdout:0",
                content: "✓ read spec.md\n· 34 passed, 0 failed\n",
                createdAt: new Date().toISOString(),
                contentLength: 38,
                contentTruncated: false,
                contentOffset: 0,
              },
            ],
            nextAfter: 1,
            hasMore: false,
          },
        },
      },
    });
    render(<SessionDetailPage />);

    const card = await screen.findByTestId("stream-raw");
    expect(card).toHaveTextContent("read spec.md");
    expect(card).toHaveTextContent("34 passed, 0 failed");
  });

  it("shows the write-path cap's elision marker as Arij's own line, not as output", async () => {
    const marker = chunkElisionMarker(8_123_456);
    installFetch({
      session: {
        ...mockSession,
        status: "running",
        chunkStreams: {
          raw: {
            chunks: [
              {
                id: "chunk-1",
                sessionId: "sess-1",
                streamType: "raw",
                sequence: 1,
                chunkKey: "stdout:0",
                content: `$ npm test\n${marker}\n· 34 passed, 0 failed\n`,
                createdAt: new Date().toISOString(),
                contentLength: 60,
                contentTruncated: false,
                contentOffset: 0,
              },
            ],
            nextAfter: 1,
            hasMore: false,
          },
        },
      },
    });
    render(<SessionDetailPage />);

    const card = await screen.findByTestId("stream-raw");
    // Legible: the whole sentence is on screen, in one element of its own —
    // not folded into the dim run of agent output around it.
    const line = within(card).getByTestId("chunk-elision-marker");
    expect(line).toHaveTextContent("8,123,456 bytes elided");
    expect(line).toHaveTextContent(SESSION_CHUNK_ELISION_LABEL);
    expect(line.textContent).toContain(marker);
    // The lines on either side are still ordinary output.
    expect(card).toHaveTextContent("npm test");
    expect(card).toHaveTextContent("34 passed, 0 failed");
  });

  it("shows the retention marker in the log pane as Arij's voice", async () => {
    // A pruned stream opens on Arij's sentence and continues with untouched
    // agent output — if the marker rendered as ordinary output, a reader
    // would take "pruned by Arij data retention" for something the agent said.
    const marker = chunkPruneMarker(2_500_000, "2026-09-05T04:30:00.000Z");
    installFetch({
      session: {
        ...mockSession,
        status: "completed",
        chunkStreams: {
          raw: {
            chunks: [
              {
                id: "chunk-1",
                sessionId: "sess-1",
                streamType: "raw",
                sequence: 1,
                chunkKey: null,
                content: `${marker}\n· 34 passed, 0 failed\n`,
                createdAt: new Date().toISOString(),
                contentLength: 60,
                contentTruncated: false,
                contentOffset: 0,
              },
            ],
            nextAfter: 1,
            hasMore: false,
          },
        },
      },
    });
    render(<SessionDetailPage />);

    const card = await screen.findByTestId("stream-raw");
    const line = within(card).getByTestId("chunk-prune-marker");
    expect(line).toHaveTextContent("2,500,000 earlier characters");
    expect(line).toHaveTextContent(SESSION_CHUNK_PRUNE_LABEL);
    // The retained tail beside it is still ordinary output.
    expect(card).toHaveTextContent("34 passed, 0 failed");
    expect(within(card).queryByTestId("chunk-elision-marker")).toBeNull();
  });

  it("shows the retention marker in the response pane too", async () => {
    const marker = chunkPruneMarker(120_000, "2026-09-05T04:30:00.000Z");
    installFetch({
      session: {
        ...mockSession,
        status: "completed",
        chunkStreams: {
          response: {
            chunks: [
              {
                id: "chunk-9",
                sessionId: "sess-1",
                streamType: "response",
                sequence: 9,
                chunkKey: null,
                content: `${marker}\nAll tests passed.`,
                createdAt: new Date().toISOString(),
                contentLength: 90,
                contentTruncated: false,
                contentOffset: 0,
              },
            ],
            nextAfter: 9,
            hasMore: false,
          },
        },
      },
    });
    render(<SessionDetailPage />);

    await userEvent.click(await screen.findByText("Réponse"));

    const pane = await screen.findByTestId("stream-response");
    const line = within(pane).getByTestId("chunk-prune-marker");
    expect(line).toHaveTextContent("120,000 earlier characters");
    expect(line).toHaveTextContent(SESSION_CHUNK_PRUNE_LABEL);
    expect(pane).toHaveTextContent("All tests passed.");
  });

  it("shows the elision marker in the response pane too", async () => {
    const marker = chunkElisionMarker(4_000_000);
    installFetch({
      session: {
        ...mockSession,
        status: "completed",
        chunkStreams: {
          response: {
            chunks: [
              {
                id: "chunk-9",
                sessionId: "sess-1",
                streamType: "response",
                sequence: 9,
                chunkKey: "final-response",
                content: `Implemented.\n${marker}\nAll tests passed.`,
                createdAt: new Date().toISOString(),
                contentLength: 90,
                contentTruncated: false,
                contentOffset: 0,
              },
            ],
            nextAfter: 9,
            hasMore: false,
          },
        },
      },
    });
    render(<SessionDetailPage />);

    await userEvent.click(await screen.findByText("Réponse"));

    const pane = await screen.findByTestId("stream-response");
    const line = within(pane).getByTestId("chunk-elision-marker");
    expect(line).toHaveTextContent("4,000,000 bytes elided");
    expect(line).toHaveTextContent(SESSION_CHUNK_ELISION_LABEL);
    expect(pane).toHaveTextContent("All tests passed.");
  });
});

describe("live session — the two performance workarounds", () => {
  it("never fetches the 1.8 MB prompt until the pane is opened, and fetches it once", async () => {
    const fetchMock = installFetch();
    const user = userEvent.setup();
    render(<SessionDetailPage />);

    await screen.findByText("Prompt composé");
    expect(calls(fetchMock, "include=prompt")).toHaveLength(0);

    await user.click(screen.getByText("voir le prompt exact →"));
    await waitFor(() => {
      expect(calls(fetchMock, "include=prompt")).toHaveLength(1);
    });
    expect(screen.getByText("THE EXACT PROMPT")).toBeInTheDocument();

    // Closing and reopening must not re-fetch it.
    await user.click(screen.getByText("voir le prompt exact →"));
    await user.click(screen.getByText("voir le prompt exact →"));
    expect(calls(fetchMock, "include=prompt")).toHaveLength(1);
  });

  it("scans the raw stream for Arij actions in its own request", async () => {
    const fetchMock = installFetch();
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(calls(fetchMock, "view=arij-actions").length).toBeGreaterThan(0);
    });
  });
});

describe("live session — session card", () => {
  it("shows the distill action only for an eligible completed session", async () => {
    installFetch();
    const eligible = render(<SessionDetailPage />);
    expect(await screen.findByText("Distill learnings")).toBeInTheDocument();
    eligible.unmount();

    for (const override of [
      { outcome: "asked_question" },
      { agentType: "memory_distill" },
      { status: "running" },
    ]) {
      installFetch({ session: { ...mockSession, ...override } });
      const { unmount } = render(<SessionDetailPage />);
      await screen.findByText("Session");
      expect(screen.queryByText("Distill learnings")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("exports the logs through a revoked object URL", async () => {
    const user = userEvent.setup();
    render(<SessionDetailPage />);

    await user.click(await screen.findByText("Export Logs"));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("hides Export Logs for a session with no logs", async () => {
    installFetch({ session: { ...mockSession, logs: null } });
    render(<SessionDetailPage />);

    await screen.findByText("Session");
    expect(screen.queryByText("Export Logs")).not.toBeInTheDocument();
  });

  it("shows the measured tokens next to the dispatch-time estimate", async () => {
    installFetch({
      session: {
        ...mockSession,
        inputTokens: 12500,
        outputTokens: 850,
        estimatedPromptTokens: 11200,
        estimatedPromptBreakdown: JSON.stringify({
          spec: 4000,
          memory: 1200,
          ticket: 2500,
          comments: 1500,
          findings: 1000,
          documents: 1000,
        }),
      },
    });
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId("session-estimated-tokens")).toBeInTheDocument();
    });

    expect(screen.getByText(/12.5k in · 850 out/)).toBeInTheDocument();
    expect(
      screen.getByText(/Estimated input: ~11.2k tokens/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Spec 4.0k/)).toBeInTheDocument();
    expect(screen.getByText(/Mem 1.2k/)).toBeInTheDocument();
  });

  it("shows the CLI options the run actually used, one row each", async () => {
    // Read from the session row, not from the named agent: the agent can be
    // edited or deleted after the run and the trace has to stay true.
    installFetch({
      session: {
        ...mockSession,
        provider: "oh-my-pi",
        cliOptions: '{"thinking":"high","advisor":true}',
      },
    });
    render(<SessionDetailPage />);

    const thinking = await screen.findByText("Thinking");
    expect(thinking.closest("div")).toHaveTextContent("Thinking");
    expect(thinking.closest("div")).toHaveTextContent("High");

    const advisor = screen.getByText("Advisor");
    expect(advisor.closest("div")).toHaveTextContent("on");
  });

  it("shows CLI default, not an em-dash, for an unset effort or permission", async () => {
    render(<SessionDetailPage />);

    await screen.findByText("Session");
    expect(screen.getAllByText("CLI default")).toHaveLength(2);
    expect(screen.queryByText("Thinking")).toBeNull();
  });
});

describe("live session — failures", () => {
  it("renders the captured error under an Error heading", async () => {
    installFetch({
      session: {
        ...mockSession,
        status: "failed",
        error: "Compilation failed with 3 errors",
      },
    });
    render(<SessionDetailPage />);

    expect(
      await screen.findByText("Compilation failed with 3 errors")
    ).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(
      screen.queryByText(/no error message captured/i)
    ).not.toBeInTheDocument();
  });

  it("says so explicitly when a failed session captured no error at all", async () => {
    installFetch({
      session: {
        ...mockSession,
        status: "failed",
        error: null,
        outcome: "error",
        logs: null,
      },
    });
    render(<SessionDetailPage />);

    expect(
      await screen.findByText(/Failed — no error message captured/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/failed before Arij could record an error message/i)
    ).toBeInTheDocument();
    // There is no Raw Logs tab any more; the copy points at the live log.
    expect(screen.getByText(/kept in the live log above/i)).toBeInTheDocument();
  });
});

describe("live session — collapsing rather than fabricating", () => {
  it("collapses FILES TOUCHED to its label line when there is no diff", async () => {
    installFetch({
      files: {
        ...mockFiles,
        diff: {
          available: false,
          reason: "no-worktree",
          branchName: null,
          baseBranch: null,
          mergeBase: null,
          behind: null,
          ahead: null,
          files: [],
          totals: null,
          truncated: false,
        },
      },
    });
    render(<SessionDetailPage />);

    expect(await screen.findByText("Files touched")).toBeInTheDocument();
    expect(screen.queryByText(/files ·/)).not.toBeInTheDocument();
    expect(screen.queryByText("lib/sse/stream.ts")).not.toBeInTheDocument();
  });

  it("collapses ENSUITE to its label line for a role with no pipeline", async () => {
    installFetch({ session: { ...mockSession, agentType: "chat" } });
    const { container } = render(<SessionDetailPage />);

    expect(await screen.findByText("Ensuite")).toBeInTheDocument();
    expect(
      container.querySelector("[data-slot='pipeline-chain']")
    ).toBeNull();
  });

  it("omits ENSUITE entirely for a failed session", async () => {
    installFetch({
      session: { ...mockSession, status: "failed", error: "boom" },
    });
    render(<SessionDetailPage />);

    await screen.findByText("Session");
    expect(screen.queryByText("Ensuite")).not.toBeInTheDocument();
  });

  it("omits the WORKTREE card when there is neither branch nor path", async () => {
    installFetch({
      session: { ...mockSession, branchName: null, worktreePath: null },
    });
    render(<SessionDetailPage />);

    await screen.findByText("Session");
    expect(screen.queryByText("Worktree")).not.toBeInTheDocument();
  });
});
