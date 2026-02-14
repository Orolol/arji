import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BugCreateDialog } from "@/components/kanban/BugCreateDialog";

describe("BugCreateDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function renderDialog(namedAgentId?: string | null) {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();

    render(
      <BugCreateDialog
        projectId="proj-1"
        open={true}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
        namedAgentId={namedAgentId}
      />
    );

    return { onOpenChange, onCreated };
  }

  it("shows Create And Fix action", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Create And Fix" })).toBeInTheDocument();
  });

  it("creates a bug with Create Bug", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: { id: "bug-1" } }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { onOpenChange, onCreated } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "App crashes on save" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Bug" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/proj-1/bugs",
      expect.objectContaining({
        method: "POST",
      })
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("creates bug and starts fix agent with Create And Fix", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "bug-1" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { sessionId: "sess-1" } }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { onOpenChange, onCreated } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Broken login redirect" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create And Fix" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/projects/proj-1/bugs",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/projects/proj-1/epics/bug-1/build",
      expect.objectContaining({
        method: "POST",
      })
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("shows error if bug is created but fix agent fails to start", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "bug-1" } }) })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Project has no git repository configured" }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { onOpenChange, onCreated } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Cannot submit form" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create And Fix" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.getByText(
          "Bug created, but failed to start fix agent: Project has no git repository configured"
        )
      ).toBeInTheDocument()
    );
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("passes namedAgentId when creating and fixing a bug", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: "bug-1" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { sessionId: "sess-1" } }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderDialog("agent-gemini");

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Settings save fails" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create And Fix" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall?.[0]).toBe("/api/projects/proj-1/epics/bug-1/build");
    const options = secondCall?.[1] as RequestInit;
    const body = JSON.parse(String(options.body));
    expect(body.namedAgentId).toBe("agent-gemini");
  });
});
