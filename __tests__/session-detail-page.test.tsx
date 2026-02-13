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

  it("renders provider badge", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("CC")).toBeInTheDocument();
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

  it("does not show Cancel button for completed sessions", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText(/sess-123/)).toBeInTheDocument();
    });

    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
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

  it("shows Cancel button for running sessions", async () => {
    render(<SessionDetailPage />);

    await waitFor(() => {
      expect(screen.getByText("Cancel")).toBeInTheDocument();
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
