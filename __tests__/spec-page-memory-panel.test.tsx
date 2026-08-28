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
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import SpecPage from "@/app/projects/[projectId]/spec/page";
import { MemoryPanel, hasAllDreamingSections } from "@/components/spec/MemoryPanel";
import { PROJECT_MEMORY_MAX_CHARS } from "@/lib/documents/memory-constants";

let activeMockEventSources: MockEventSource[] = [];

class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    activeMockEventSources.push(this);
  }
  close() {
    activeMockEventSources = activeMockEventSources.filter((es) => es !== this);
  }
  emit(type: string, data: Record<string, unknown> = {}) {
    this.onmessage?.({
      data: JSON.stringify({ type, projectId: "proj-1", data, timestamp: new Date().toISOString() }),
    });
  }
}
(globalThis as Record<string, unknown>).EventSource = MockEventSource;

const mockRouterPush = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-mem-1" }),
  useRouter: () => ({ push: mockRouterPush }),
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

  /**
   * The cap indicator is a three-step ramp: under → approaching → over. The
   * middle step used to be `you-deep`, which resolves to the SAME #a63a1a as
   * `danger` in both themes, so "approaching" rendered identically to "over"
   * and the warning step was invisible. Each step must be its own colour.
   */
  it("gives the approaching-cap step its own colour, distinct from the over-cap one", async () => {
    async function capToneClass(content: string): Promise<string> {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            content,
            exists: true,
            updatedAt: null,
            maxChars: PROJECT_MEMORY_MAX_CHARS,
            provenance: null,
            archive: null,
            pendingWriter: null,
          },
        }),
      });
      const view = render(<MemoryPanel projectId="proj-1" mode="edit" />);
      await waitFor(() => {
        expect(screen.getByTestId("memory-cap-indicator")).toHaveTextContent(
          `${content.length} / ${PROJECT_MEMORY_MAX_CHARS}`
        );
      });
      const className =
        screen
          .getByTestId("memory-cap-indicator")
          .querySelector('[data-slot="mono"]')?.className ?? "";
      view.unmount();
      return className;
    }

    const under = await capToneClass("x".repeat(1_000));
    const approaching = await capToneClass("x".repeat(11_000));
    const over = await capToneClass("x".repeat(12_050));

    expect(new Set([under, approaching, over]).size).toBe(3);
    expect(over).toContain("text-destructive");
    expect(approaching).not.toContain("text-destructive");
    // `--strata-you-deep` IS `--destructive`; the middle step must not use it.
    expect(approaching).not.toContain("text-strata-you-deep");
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

  it("preserves unsaved user edits when background update arrives, shows conflict notice, and loads new content on Discard", async () => {
    // 1. Initial load
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Initial server memory",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: { source: "manual", sessionId: null, at: "2026-01-01T00:00:00.000Z" },
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-editor")).toHaveValue("Initial server memory");
    });

    // 2. User types an unsaved local edit (dirty = true)
    const editor = screen.getByTestId("memory-editor");
    fireEvent.change(editor, { target: { value: "My unsaved local draft" } });
    expect(editor).toHaveValue("My unsaved local draft");

    // 3. Background update arrives (e.g. Dreaming completed and emitted memory:changed)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Updated background memory from agent",
          exists: true,
          updatedAt: "2026-01-01T01:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: { source: "dreaming", sessionId: "sess-dream-99", at: "2026-01-01T01:00:00.000Z" },
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    // Emit memory:changed SSE event
    act(() => {
      activeMockEventSources.forEach((es) => es.emit("memory:changed"));
    });

    // 4. Verify local draft is preserved and conflict notice is displayed
    await waitFor(() => {
      expect(screen.getByTestId("memory-conflict-notice")).toBeDefined();
      expect(screen.getByText(/updated in the background while you were editing/i)).toBeDefined();
    });
    expect(editor).toHaveValue("My unsaved local draft");

    // 5. User clicks Discard -> loads the NEW server content and clears conflict notice
    const discardBtn = screen.getByRole("button", { name: "Discard" });
    fireEvent.click(discardBtn);

    expect(editor).toHaveValue("Updated background memory from agent");
    expect(screen.queryByTestId("memory-conflict-notice")).toBeNull();
  });

  it("live syncs on session:started and memory:changed events without page reload", async () => {
    // Initial mount with no writer
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Current memory text",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-editor")).toBeEnabled();
    });
    expect(screen.queryByTestId("memory-pending-writer-banner")).toBeNull();

    // Background Dreaming starts -> emits session:started
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Current memory text",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: {
            sessionId: "sess-dreaming-live",
            agentType: "dreaming",
          },
        },
      }),
    });

    act(() => {
      activeMockEventSources.forEach((es) =>
        es.emit("session:started", {
          sessionId: "sess-dreaming-live",
          agentType: "dreaming",
        })
      );
    });

    // Panel updates live to read-only mode with banner
    await waitFor(() => {
      expect(screen.getByTestId("memory-pending-writer-banner")).toBeDefined();
      expect(screen.getByTestId("memory-editor")).toBeDisabled();
    });

    // Dreaming finishes -> emits memory:changed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Newly dreamed memory text",
          exists: true,
          updatedAt: "2026-01-01T02:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: { source: "dreaming", sessionId: "sess-dreaming-live", at: "2026-01-01T02:00:00.000Z" },
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    act(() => {
      activeMockEventSources.forEach((es) => es.emit("memory:changed"));
    });

    // Banner clears, editor re-enables and displays new content
    await waitFor(() => {
      expect(screen.queryByTestId("memory-pending-writer-banner")).toBeNull();
      expect(screen.getByTestId("memory-editor")).toBeEnabled();
      expect(screen.getByTestId("memory-editor")).toHaveValue("Newly dreamed memory text");
    });
  });

  it("appends missing sections to non-empty memory rather than replacing the whole document", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "## Codebase pitfalls\n\n- Do not mutate state directly.",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
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

    const appendBtn = screen.getByRole("button", { name: /append missing sections/i });
    fireEvent.click(appendBtn);

    const editor = screen.getByTestId("memory-editor") as HTMLTextAreaElement;
    expect(editor.value).toContain("## Codebase pitfalls\n\n- Do not mutate state directly.");
    expect(editor.value).toContain("## Recurring agent mistakes");
    expect(editor.value).toContain("## Strategies that work");
    expect(editor.value).toContain("## Build instructions");
    expect(hasAllDreamingSections(editor.value)).toBe(true);
  });

  it("navigates to dream session using router.push on manual dream", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "## Codebase pitfalls\n\n- Some note",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Dream" })).toBeEnabled();
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          sessionId: "sess-dream-new-456",
        },
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Dream" }));

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/projects/proj-1/sessions/sess-dream-new-456");
    });
  });
  it("does not show conflict notice when refetch returns identical content while dirty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Initial server memory",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-editor")).toHaveValue("Initial server memory");
    });

    // User types local draft (dirty)
    const editor = screen.getByTestId("memory-editor");
    fireEvent.change(editor, { target: { value: "My unsaved local draft" } });
    expect(editor).toHaveValue("My unsaved local draft");

    // Background event triggers refetch, but server content has NOT changed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Initial server memory",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    act(() => {
      activeMockEventSources.forEach((es) => es.emit("memory:changed"));
    });

    // Local draft is preserved, but NO conflict notice is shown
    await waitFor(() => {
      expect(screen.queryByTestId("memory-conflict-notice")).toBeNull();
    });
    expect(editor).toHaveValue("My unsaved local draft");
  });

  it("clears pendingWriter banner when writer session completes without writing (session:completed)", async () => {
    // 1. Initial mount with active writer
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Original memory",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: {
            sessionId: "sess-dream-discarded",
            agentType: "dreaming",
          },
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-pending-writer-banner")).toBeDefined();
      expect(screen.getByTestId("memory-editor")).toBeDisabled();
    });

    // 2. Writer finishes without writing (e.g. discarded or no output) -> emits session:completed
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Original memory",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    act(() => {
      activeMockEventSources.forEach((es) =>
        es.emit("session:completed", {
          sessionId: "sess-dream-discarded",
          agentType: "dreaming",
        })
      );
    });

    // Banner clears and editor is re-enabled
    await waitFor(() => {
      expect(screen.queryByTestId("memory-pending-writer-banner")).toBeNull();
      expect(screen.getByTestId("memory-editor")).toBeEnabled();
    });
  });

  it("clears pendingWriter banner when writer session fails (session:failed)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Original memory",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: {
            sessionId: "sess-distill-failed",
            agentType: "memory_distill",
          },
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-pending-writer-banner")).toBeDefined();
      expect(screen.getByTestId("memory-editor")).toBeDisabled();
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Original memory",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    act(() => {
      activeMockEventSources.forEach((es) =>
        es.emit("session:failed", {
          sessionId: "sess-distill-failed",
          agentType: "memory_distill",
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByTestId("memory-pending-writer-banner")).toBeNull();
      expect(screen.getByTestId("memory-editor")).toBeEnabled();
    });
  });

  it("does not refetch on unrelated session lifecycle events (e.g. build session)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Original memory",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-editor")).toBeEnabled();
    });

    const fetchCallCountBefore = mockFetch.mock.calls.length;

    // Unrelated build session starts
    act(() => {
      activeMockEventSources.forEach((es) =>
        es.emit("session:started", {
          sessionId: "sess-build-123",
          agentType: "build",
        })
      );
    });

    // No refetch triggered
    expect(mockFetch.mock.calls.length).toBe(fetchCallCountBefore);
  });

  it("does not show structure hint when all 4 sections exist even with custom sections or preamble", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: `# Project overview\n\nSome preamble.\n\n## Codebase pitfalls\n\n- Pitfall\n\n## Recurring agent mistakes\n\n- Mistake\n\n## Strategies that work\n\n- Strategy\n\n## Build instructions\n\n- Build\n\n## Team conventions\n\n- Custom section`,
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-editor")).toBeEnabled();
    });

    // Structure hint is NOT displayed because all 4 required sections exist
    expect(screen.queryByTestId("memory-skeleton-suggestion")).toBeNull();
  });

  it("handleInsertSkeleton leaves content untouched when all 4 sections already exist", async () => {
    const memoryWithAllSections = `## Codebase pitfalls\n\n- 1\n\n## Recurring agent mistakes\n\n- 2\n\n## Strategies that work\n\n- 3\n\n## Build instructions\n\n- 4\n\n## Extra notes\n\n- Keep this!`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: memoryWithAllSections,
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: null,
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByTestId("memory-editor")).toHaveValue(memoryWithAllSections);
    });

    // Even if somehow triggered, content is untouched
    const editor = screen.getByTestId("memory-editor");
    expect(editor).toHaveValue(memoryWithAllSections);
  });

  it("disables Restore snapshot button when editor is dirty with explanatory title", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          content: "Saved memory text",
          exists: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
          maxChars: PROJECT_MEMORY_MAX_CHARS,
          provenance: null,
          archive: {
            content: "Old pre-dream snapshot",
            updatedAt: "2025-12-31T00:00:00.000Z",
          },
          pendingWriter: null,
        },
      }),
    });

    render(<MemoryPanel projectId="proj-1" mode="edit" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore snapshot/i })).toBeEnabled();
    });

    // User edits textarea
    const editor = screen.getByTestId("memory-editor");
    fireEvent.change(editor, { target: { value: "Unsaved modifications" } });

    // Restore snapshot button is disabled while dirty
    const restoreBtn = screen.getByRole("button", { name: /restore snapshot/i });
    expect(restoreBtn).toBeDisabled();
    expect(restoreBtn).toHaveAttribute(
      "title",
      expect.stringMatching(/save or discard your edits first/i)
    );
  });
});
