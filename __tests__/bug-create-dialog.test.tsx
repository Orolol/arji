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

  it("names the refused field instead of repeating the schema's summary", async () => {
    // `validateBody` answers `{ error: "Validation failed", details }`. Showing
    // `error` alone would tell the reporter their bug was refused and nothing
    // whatsoever about what to change.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "Validation failed",
        details: { description: ["Too big: expected string to have <=10000 characters"] },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { onOpenChange, onCreated } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Bug title..."), {
      target: { value: "Very long report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Bug" }));

    await waitFor(() =>
      expect(
        screen.getByText("Too big: expected string to have <=10000 characters")
      ).toBeInTheDocument()
    );
    expect(screen.queryByText("Validation failed")).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("ignores a second Enter while the create request is in flight", async () => {
    // The buttons go disabled, but the title field stays live and Enter calls
    // handleSubmit directly — so nothing but a synchronous lock stops the same
    // report being filed twice.
    let releaseCreate: (() => void) | null = null;
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return { ok: true, json: async () => ({ data: { id: "bug-1" } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { onOpenChange, onCreated } = renderDialog();

    const titleField = screen.getByPlaceholderText("Bug title...");
    fireEvent.change(titleField, { target: { value: "Duplicate on Enter" } });

    fireEvent.keyDown(titleField, { key: "Enter" });
    fireEvent.keyDown(titleField, { key: "Enter" });
    fireEvent.keyDown(titleField, { key: "Enter" });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseCreate!();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter while Create And Fix is in flight, so no bug is left undispatched", async () => {
    // The damage here is worse than a duplicate: the first bug gets the agent
    // and the second is filed with nobody working on it.
    let releaseCreate: (() => void) | null = null;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/bugs")) {
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
        return { ok: true, json: async () => ({ data: { id: "bug-1" } }) };
      }
      return { ok: true, json: async () => ({ data: { sessionId: "sess-1" } }) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { onOpenChange } = renderDialog();

    const titleField = screen.getByPlaceholderText("Bug title...");
    fireEvent.change(titleField, { target: { value: "Crash on export" } });
    fireEvent.click(screen.getByRole("button", { name: "Create And Fix" }));

    fireEvent.keyDown(titleField, { key: "Enter" });

    const bugCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/bugs"));
    expect(bugCalls()).toHaveLength(1);

    releaseCreate!();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(bugCalls()).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/build"))
    ).toHaveLength(1);
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
