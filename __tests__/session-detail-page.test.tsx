import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

// Mock next/navigation
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

// Mock fetch
const mockSession = {
  id: "sess-12345678",
  status: "completed",
  mode: "code",
  provider: "claude-code",
  prompt: "Build the feature",
  branchName: "feature/test",
  worktreePath: "/tmp/worktree",
  startedAt: new Date(Date.now() - 60000).toISOString(),
  completedAt: new Date().toISOString(),
  createdAt: new Date(Date.now() - 120000).toISOString(),
  lastNonEmptyText: "All tests passed.",
  outcome: "answered",
  error: null,
  logs: {
    success: true,
    result: "Feature implemented successfully.\n\nAll tests passed.\nBuild succeeded.",
    duration: 60000,
  },
};

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ data: mockSession }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// We need to import after mocks are set up
import SessionDetailPage from "@/app/projects/[projectId]/sessions/[sessionId]/page";

describe("SessionDetailPage", () => {
  it("renders session header with status badge", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/sess-123/)).toBeInTheDocument();
    });

    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
  });

  it("renders lastNonEmptyText when available", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("All tests passed.")).toBeInTheDocument();
    });
  });

  it("renders the delivery-verdict badge", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId("session-outcome-answered")).toBeInTheDocument();
    });
    expect(screen.getByText("Answered")).toBeInTheDocument();
  });

  it("renders provider badge", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Claude Code")).toBeInTheDocument();
    });
  });

  it("renders branch name", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("feature/test")).toBeInTheDocument();
    });
  });

  it("response tab content has monospace and scroll styles", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/Feature implemented successfully/)
      ).toBeInTheDocument();
    });

    const responseContent = screen.getByText(
      /Feature implemented successfully/
    ).closest("div");

    // Verify the scroll container has the expected CSS classes
    expect(responseContent).toBeDefined();
    // The parent ScrollPane should have overflow and font-mono classes
    const scrollPane = responseContent?.closest(
      ".overflow-y-auto"
    );
    expect(scrollPane).toBeDefined();
  });

  it("renders tabs for Response, Prompt, and Raw Logs", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Response" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Prompt" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Raw Logs" })).toBeInTheDocument();
    });
  });

  it("does not show the Stop button for completed sessions", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/sess-123/)).toBeInTheDocument();
    });

    expect(screen.queryByText("Stop")).not.toBeInTheDocument();
  });

  it("renders the key/value rows of the session panel", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Started")).toBeInTheDocument();
    });
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByText("Tokens")).toBeInTheDocument();
  });
});

describe("SessionDetailPage - running session", () => {
  beforeEach(() => {
    const runningSession = {
      ...mockSession,
      status: "running",
      completedAt: null,
      lastNonEmptyText: "Working on implementation...",
      logs: null,
    };

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: runningSession }),
    });
  });

  it("shows the Stop button for running sessions", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeInTheDocument();
    });
  });

  it("shows waiting message when no response yet", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText("Waiting for agent to respond...")
      ).toBeInTheDocument();
    });
  });

  it("shows In progress for completion time", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("In progress...")).toBeInTheDocument();
    });
  });
});

describe("SessionDetailPage - error session", () => {
  beforeEach(() => {
    const errorSession = {
      ...mockSession,
      status: "failed",
      error: "Compilation failed with 3 errors",
      logs: {
        success: false,
        error: "Compilation failed with 3 errors",
        duration: 10000,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: errorSession }),
    });
  });

  it("renders error card", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText("Compilation failed with 3 errors")
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("does not show the no-error-captured box when an error IS present", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText("Compilation failed with 3 errors")
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByText(/no error message captured/i)
    ).not.toBeInTheDocument();
  });
});

describe("SessionDetailPage - failed session without captured error", () => {
  beforeEach(() => {
    // The legacy/worst case: the session row says failed but carries no error
    // text (predates the failure-message synthesis). The view must say so
    // explicitly and point at the logs instead of showing nothing.
    const silentFailedSession = {
      ...mockSession,
      status: "failed",
      error: null,
      outcome: "error",
      lastNonEmptyText: null,
      logs: null,
    };

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: silentFailedSession }),
    });
  });

  it("shows the explicit no-error-captured notice with a pointer to the logs", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/Failed — no error message captured/i)
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText(/failed before Arij could record an error message/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Raw Logs tab/i)).toBeInTheDocument();
  });
});

describe("SessionDetailPage - large payload rendering", () => {
  beforeEach(() => {
    // Create a very large payload
    const largeResult = Array.from({ length: 2000 }, (_, i) =>
      `Line ${i + 1}: ${"x".repeat(100)}`
    ).join("\n");

    const largeSession = {
      ...mockSession,
      logs: {
        success: true,
        result: largeResult,
        duration: 120000,
      },
    };

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: largeSession }),
    });
  });

  it("renders large payloads within scroll containers", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      // Verify it rendered without crashing
      expect(screen.getByText(/Line 1:/)).toBeInTheDocument();
    });

    // The content should be inside a scrollable container
    const content = screen.getByText(/Line 1:/);
    const scrollContainer = content.closest(".overflow-y-auto");
    expect(scrollContainer).toBeDefined();
    expect(scrollContainer?.classList.contains("max-h-[500px]")).toBe(true);
  });
});

describe("SessionDetailPage - estimated prompt tokens", () => {
  beforeEach(() => {
    const estimatedSession = {
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
    };

    global.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ data: estimatedSession }),
    });
  });

  it("renders estimated input tokens side-by-side with measured tokens", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId("session-estimated-tokens")).toBeInTheDocument();
    });

    expect(screen.getByText(/12.5k in · 850 out/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated input: ~11.2k tokens/)).toBeInTheDocument();
    expect(screen.getByText(/Spec 4.0k/)).toBeInTheDocument();
    expect(screen.getByText(/Mem 1.2k/)).toBeInTheDocument();
  });
});

describe("SessionDetailPage - CLI options in effect", () => {
  it("shows the options the run actually used, labelled", async () => {
    // Read from the session row, not from the named agent: the agent can be
    // edited or deleted after the run and the trace has to stay true.
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            ...mockSession,
            provider: "oh-my-pi",
            cliOptions: '{"thinking":"high","advisor":true}',
          },
        }),
    });

    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Thinking: High")).toBeInTheDocument();
    });
    expect(screen.getByText("Advisor: on")).toBeInTheDocument();
  });

  it("shows nothing extra for a session that used no options", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("completed")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Thinking:/)).toBeNull();
  });
});
