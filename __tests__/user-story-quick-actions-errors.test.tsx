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

  it("shows the server error when approve is refused", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Story must be in review status to approve",
      }),
    }) as unknown as typeof fetch;

    renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(screen.getByTestId("story-quick-action-error")).toHaveTextContent(
        "Story must be in review status to approve",
      );
    });
  });

  it("treats a 200 approve that completed the epic's stories as clean — the epic merges elsewhere", async () => {
    // Story approval never merges: `merged: false` with `epicComplete: true`
    // is the normal last-story response, not a failure to warn about.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { approved: true, epicComplete: true, merged: false },
      }),
    }) as unknown as typeof fetch;

    renderSubject();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("story-quick-action-error")).not.toBeInTheDocument();
  });

  it("shows no error and refreshes on a clean approve", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { approved: true, epicComplete: false, merged: false },
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
