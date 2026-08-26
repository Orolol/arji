/**
 * Component tests for the Spec & Memory section and MemoryPanel:
 * - Equal peer layout (Spec next to Memory)
 * - Empty state and 4-sections skeleton template
 * - Edit and preview modes
 * - Character cap indicator and approaching warning
 * - Provenance display
 * - Pre-dream snapshot restore with explicit confirmation
 * - Read-only mode and banner during active agent rewrite (pendingWriter)
 */
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import SpecPage from "@/app/projects/[projectId]/spec/page";
import { MemoryPanel, hasAllDreamingSections } from "@/components/spec/MemoryPanel";
import { PROJECT_MEMORY_MAX_CHARS } from "@/lib/documents/memory-constants";
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-mem-1" }),
}));

// Mock fetch globally for testing
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("spec page — paired memory card structure (Story 1 & 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/memory")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              content: "",
              exists: false,
              updatedAt: null,
              maxChars: PROJECT_MEMORY_MAX_CHARS,
              provenance: null,
              archive: null,
              pendingWriter: null,
            },
          }),
        };
      }
      if (urlStr.endsWith("/spec/update")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { pending: false } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            spec: "# Spec\n\nArchitecture details.",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      };
    });
  });

  it("renders the memory card next to the spec editor as equal peers", async () => {
    render(<SpecPage params={Promise.resolve({ projectId: "project-mem-1" })} />);

    await waitFor(() => {
      expect(screen.getByText("Specification")).toBeDefined();
      expect(screen.getByText("Project memory")).toBeDefined();
    });

    expect(screen.getByTestId("spec-card")).toBeDefined();
    expect(screen.getByTestId("memory-card")).toBeDefined();
    expect(screen.getAllByTestId("memory-card")).toHaveLength(1);
  });

  it("shows the empty state and cap indicator before learned memory exists", async () => {
    render(<SpecPage params={Promise.resolve({ projectId: "project-mem-1" })} />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-cap-indicator")).toHaveTextContent(
        `0 / ${PROJECT_MEMORY_MAX_CHARS}`
      );
    });

    expect(screen.getByTestId("memory-skeleton-suggestion")).toBeDefined();
  });
});

describe("MemoryPanel component (Story 2, 3 & 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supports inserting the 4 Dreaming sections template", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "",
          exists: false,
          updatedAt: null,
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-skeleton-suggestion")).toBeDefined();
    });

    const insertBtn = screen.getByRole("button", { name: /template/i });
    fireEvent.click(insertBtn);

    const editor = screen.getByTestId("memory-editor") as HTMLTextAreaElement;
    expect(editor.value).toContain("## Codebase pitfalls");
    expect(editor.value).toContain("## Recurring agent mistakes");
    expect(editor.value).toContain("## Strategies that work");
    expect(editor.value).toContain("## Build instructions");
    expect(hasAllDreamingSections(editor.value)).toBe(true);
  });

  it("switches to preview mode cleanly", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "## Codebase pitfalls\n\n- Do not mutate global state.",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: { source: "manual", sessionId: null, at: "2026-01-01T00:00:00.000Z" },
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    const { rerender } = render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-editor")).toBeDefined();
    });

    rerender(<MemoryPanel projectId="proj-1" mode="preview" />);
    expect(screen.getByTestId("memory-preview")).toBeDefined();
    expect(screen.getByText("Codebase pitfalls")).toBeDefined();
  });

  it("displays provenance and formatted timestamp", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "## Strategies that work\n\n- Keep tests isolated.",
          exists: true,
          updatedAt: "2026-01-01T12:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: {
            source: "dreaming",
            sessionId: "sess-dream-123",
            at: "2026-01-01T12:00:00.000Z",
          },
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-provenance-bar")).toHaveTextContent("Dreaming");
      expect(screen.getByRole("link", { name: /view session/i })).toHaveAttribute(
        "href",
        "/projects/proj-1/sessions/sess-dream-123"
      );
    });
  });

  it("displays warning when approaching the cap and blocks save when over cap", async () => {
    const approachingContent = "x".repeat(11000);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: approachingContent,
          exists: true,
          updatedAt: "2026-01-01T12:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByText(/Approaching the 12000-character cap/i)).toBeDefined();
    });

    // Type more to exceed the cap
    const editor = screen.getByTestId("memory-editor");
    fireEvent.change(editor, { target: { value: "x".repeat(12050) } });

    await waitFor(() => {
      expect(screen.getByText(/Over the 12000-character cap/i)).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Save memory" })).toBeDisabled();
  });

  it("requires explicit confirmation before restoring pre-dream snapshot", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Current memory text",
          exists: true,
          updatedAt: "2026-01-02T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: { source: "dreaming", sessionId: "sess-1", at: "2026-01-02T00:00:00.000Z" },
          archive: {
            content: "Pre-dream snapshot text",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-archive-bar")).toBeDefined();
    });

    // Click "Restore snapshot" -> enters confirmation mode
    const restoreBtn = screen.getByRole("button", { name: /restore snapshot/i });
    fireEvent.click(restoreBtn);

    expect(screen.getByText("Replace with snapshot?")).toBeDefined();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();

    // Mock restore POST endpoint
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Pre-dream snapshot text",
          exists: true,
          updatedAt: "2026-01-03T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: { source: "manual", sessionId: null, at: "2026-01-03T00:00:00.000Z" },
          archive: {
            content: "Pre-dream snapshot text",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          pendingWriter: null,
        },
      }),
    });

    // Confirm restore
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(screen.getByText("Restored the memory to the pre-dream snapshot.")).toBeDefined();
    });
  });

  it("enforces read-only mode and displays banner during active agent rewrite (pendingWriter)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Memory being rewritten",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: {
            sessionId: "sess-dreaming-active",
            agentType: "dreaming",
          },
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-pending-writer-banner")).toBeDefined();
      expect(screen.getByText(/A Dreaming rewrite is currently in progress/i)).toBeDefined();
      expect(screen.getByRole("link", { name: /view session/i })).toHaveAttribute(
        "href",
        "/projects/proj-1/sessions/sess-dreaming-active"
      );
    });

    // Editor and Save button are disabled in read-only mode
    expect(screen.getByTestId("memory-editor")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save memory" })).toBeDisabled();
  });
});
