import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserStoryQuickActions } from "@/components/epic/UserStoryQuickActions";

describe("UserStoryQuickActions error surfacing", () => {
  const onRefresh = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    onRefresh.mockClear();
  });

  function renderSubject(status = "review") {
    render(
      <TooltipProvider>
        <UserStoryQuickActions
          projectId="proj-1"
          story={{ id: "story-1", status }}
          onRefresh={onRefresh}
        />
      </TooltipProvider>,
    );
  }

  it("shows the server error when approve fails with a merge conflict", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error:
          "Merge failed: conflict in lib/foo.ts — resolve the conflict (Resolve Merge) and approve again.",
        mergeFailed: true,
      }),
    }) as unknown as typeof fetch;

    renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(screen.getByTestId("story-quick-action-error")).toHaveTextContent(
        "Merge failed: conflict in lib/foo.ts — resolve the conflict (Resolve Merge) and approve again.",
      );
    });
  });

  it("warns when a 200 approve response reports a failed epic merge", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          approved: true,
          epicComplete: true,
          merged: false,
          mergeError: "conflict in lib/foo.ts",
        },
      }),
    }) as unknown as typeof fetch;

    renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(screen.getByTestId("story-quick-action-error")).toHaveTextContent(
        "Story approved, but the epic merge failed: conflict in lib/foo.ts",
      );
    });
    // The story itself was approved — the list must still refresh.
    expect(onRefresh).toHaveBeenCalled();
  });

  it("shows no error and refreshes on a clean approve", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { approved: true, epicComplete: true, merged: true, commitHash: "abc" },
      }),
    }) as unknown as typeof fetch;

    renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("story-quick-action-error")).not.toBeInTheDocument();
  });

  it("surfaces build dispatch failures instead of swallowing them", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "No provider configured" }),
    }) as unknown as typeof fetch;

    renderSubject("todo");
    fireEvent.click(screen.getByRole("button", { name: "Send to Dev" }));

    await waitFor(() => {
      expect(screen.getByTestId("story-quick-action-error")).toHaveTextContent(
        "No provider configured",
      );
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
