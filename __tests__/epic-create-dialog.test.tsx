import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EpicCreateDialog } from "@/components/kanban/EpicCreateDialog";
import {
  EPIC_TITLE_MAX_LENGTH,
  EPIC_TITLE_TOO_LONG,
} from "@/lib/epics/manual-epic-form";

describe("EpicCreateDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function renderDialog() {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();

    render(
      <EpicCreateDialog
        projectId="proj-1"
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />,
    );

    return { onOpenChange, onCreated };
  }

  /**
   * Wires `open` to real state the way `app/projects/[projectId]/page.tsx`
   * does, so closing actually unmounts the form. `renderDialog` pins `open`,
   * which cannot show what the *next* open of the dialog contains.
   */
  function renderReopenableDialog() {
    const onCreated = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button data-testid="reopen" onClick={() => setOpen(true)}>
            New Epic
          </button>
          <EpicCreateDialog
            projectId="proj-1"
            open={open}
            onOpenChange={setOpen}
            onCreated={onCreated}
          />
        </>
      );
    }

    render(<Harness />);
    return { onCreated };
  }

  function mockFetchOk() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "epic-1", userStoriesCreated: 0 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function lastBody(fetchMock: ReturnType<typeof vi.fn>) {
    const [, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return JSON.parse(init.body as string);
  }

  it("creates a title-only epic without touching any agent route", async () => {
    const fetchMock = mockFetchOk();
    const { onOpenChange, onCreated } = renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "  Direct epic  " },
    });
    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/proj-1/epics");
    expect(lastBody(fetchMock)).toEqual({
      title: "Direct epic",
      description: null,
      status: "backlog",
      type: "feature",
      userStories: [],
    });

    // No chat / build / conversation call — the manual path is agent-free.
    for (const [url] of fetchMock.mock.calls) {
      expect(url).not.toMatch(/\/(chat|build|conversations|review)/);
    }

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onCreated).toHaveBeenCalledWith("epic-1");
  });

  it("pre-fills and attributes a friction conversion through the same create route", async () => {
    const fetchMock = mockFetchOk();
    render(
      <EpicCreateDialog
        projectId="proj-1"
        open
        onOpenChange={vi.fn()}
        frictionId="friction-7"
        initialDraft={{
          title: "Broken tooling: scripts/check.sh",
          description: "The script exits without diagnostics.",
          userStories: [],
        }}
        submitLabel="Create Ticket"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("epic-title-input")).toHaveValue(
        "Broken tooling: scripts/check.sh",
      ),
    );
    expect(screen.getByTestId("epic-description-input")).toHaveValue(
      "The script exits without diagnostics.",
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Ticket" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastBody(fetchMock)).toMatchObject({
      title: "Broken tooling: scripts/check.sh",
      frictionId: "friction-7",
      status: "backlog",
      type: "feature",
    });
  });

  it("posts added user stories in one request", async () => {
    const fetchMock = mockFetchOk();
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    fireEvent.change(screen.getByTestId("epic-description-input"), {
      target: { value: "## Context\n\nMarkdown survives the round trip." },
    });

    await user.click(screen.getByTestId("add-user-story"));
    await user.click(screen.getByTestId("add-user-story"));

    const titles = screen.getAllByTestId("user-story-title-input");
    expect(titles).toHaveLength(2);
    fireEvent.change(titles[0], { target: { value: "First story" } });
    fireEvent.change(titles[1], { target: { value: "Second story" } });

    const criteria = screen.getAllByTestId("user-story-criteria-input");
    fireEvent.change(criteria[0], { target: { value: "- [ ] works" } });

    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = lastBody(fetchMock);
    expect(body.description).toBe("## Context\n\nMarkdown survives the round trip.");
    expect(body.userStories).toEqual([
      { title: "First story", description: null, acceptanceCriteria: "- [ ] works" },
      { title: "Second story", description: null, acceptanceCriteria: null },
    ]);
  });

  it("blocks submit and shows an error when the title is blank", async () => {
    const fetchMock = mockFetchOk();
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("epic-title-error")).toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("blocks submit on an over-long title instead of spending a round trip on a 400", async () => {
    const fetchMock = mockFetchOk();
    renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "x".repeat(EPIC_TITLE_MAX_LENGTH + 1) },
    });
    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("epic-title-error")).toHaveTextContent(
        EPIC_TITLE_TOO_LONG,
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    // Trimming back under the cap clears the error and lets the epic through.
    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    expect(screen.queryByTestId("epic-title-error")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("epic-create-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("shows which field the server rejected rather than a bare 'Validation failed'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "Validation failed",
        details: { title: ["Too big: expected string to have <=200 characters"] },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("epic-create-error")).toHaveTextContent(
        "Validation failed — title: Too big: expected string to have <=200 characters",
      ),
    );
  });

  it("blocks submit when an added user story has no title", async () => {
    const fetchMock = mockFetchOk();
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    await user.click(screen.getByTestId("add-user-story"));
    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() =>
      expect(screen.getByText("User story title is required")).toBeInTheDocument(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes one user story block and leaves its neighbours untouched", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("add-user-story"));
    await user.click(screen.getByTestId("add-user-story"));
    await user.click(screen.getByTestId("add-user-story"));

    const titles = screen.getAllByTestId("user-story-title-input");
    fireEvent.change(titles[0], { target: { value: "Keep first" } });
    fireEvent.change(titles[1], { target: { value: "Drop middle" } });
    fireEvent.change(titles[2], { target: { value: "Keep last" } });

    await user.click(screen.getAllByTestId("remove-user-story")[1]);

    // Asserting the surviving titles, not just the count: removal is keyed,
    // and an index-based bug would still leave two blocks standing.
    const remaining = screen.getAllByTestId("user-story-title-input");
    expect(remaining.map((input) => (input as HTMLInputElement).value)).toEqual([
      "Keep first",
      "Keep last",
    ]);
  });

  it("disables the submit button and shows a spinner while the request is in flight", async () => {
    let settleFetch: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockReturnValue(new Promise((resolve) => (settleFetch = resolve)));
    global.fetch = fetchMock as unknown as typeof fetch;
    renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });

    const submit = screen.getByTestId("epic-create-submit");
    expect(submit).not.toBeDisabled();
    expect(screen.queryByTestId("epic-create-spinner")).not.toBeInTheDocument();

    fireEvent.click(submit);

    await waitFor(() => expect(submit).toBeDisabled());
    expect(screen.getByTestId("epic-create-spinner")).toBeInTheDocument();
    // Cancel locks too, so an in-flight create can't be abandoned half-written.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    // A double-click while in flight must not create the epic twice.
    fireEvent.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    settleFetch({ ok: true, json: async () => ({ data: { id: "epic-1" } }) });

    await waitFor(() =>
      expect(screen.queryByTestId("epic-create-spinner")).not.toBeInTheDocument(),
    );
    expect(submit).not.toBeDisabled();
  });

  // The fields scroll inside the dialog body while Create sits in the footer
  // outside it. Without focus management a blocked submit can render its only
  // feedback off-screen, and the button reads as dead.
  it("sends the caret to the empty epic title when submit is blocked", async () => {
    const fetchMock = mockFetchOk();
    const user = userEvent.setup();
    renderDialog();

    // Move focus off the autofocused title first, the way typing anywhere else
    // would — otherwise the assertion would pass without any focus call.
    const description = screen.getByTestId("epic-description-input");
    await user.click(description);
    expect(description).toHaveFocus();

    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() => expect(screen.getByTestId("epic-title-input")).toHaveFocus());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the caret to the first untitled story, not merely to some story", async () => {
    const user = userEvent.setup();
    renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    await user.click(screen.getByTestId("add-user-story"));
    await user.click(screen.getByTestId("add-user-story"));
    await user.click(screen.getByTestId("add-user-story"));

    const titles = screen.getAllByTestId("user-story-title-input");
    fireEvent.change(titles[0], { target: { value: "Titled" } });
    fireEvent.change(titles[2], { target: { value: "Also titled" } });

    fireEvent.click(screen.getByTestId("epic-create-submit"));

    // The middle one is the offender: landing on the first or last block would
    // leave the user hunting for the message.
    await waitFor(() => expect(titles[1]).toHaveFocus());
  });

  it("names the failing field to a screen reader instead of only colouring it", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("add-user-story"));
    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("epic-title-error")).toBeInTheDocument(),
    );

    // aria-invalid says "wrong" but not why; the description link carries the
    // sentence, and role=alert is what makes it announced at all.
    for (const [input, message] of [
      [screen.getByTestId("epic-title-input"), "Title is required"],
      [
        screen.getByTestId("user-story-title-input"),
        "User story title is required",
      ],
    ] as const) {
      const describedBy = input.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const errorNode = document.getElementById(describedBy as string);
      expect(errorNode).toHaveTextContent(message);
      expect(errorNode).toHaveAttribute("role", "alert");
    }
  });

  it("keeps a rejected request's message out of the scrolling body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Failed to create epic" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    fireEvent.click(screen.getByTestId("epic-create-submit"));

    const error = await screen.findByTestId("epic-create-error");
    expect(error).toHaveAttribute("role", "alert");
    // Inside the scroll container it would sit under however many story blocks
    // the user added, i.e. below the fold, while Create looks unresponsive.
    expect(screen.getByTestId("epic-create-body")).not.toContainElement(error);
  });

  it("keeps the dialog open with the draft intact when the request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Failed to create epic" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { onOpenChange, onCreated } = renderDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("epic-create-error")).toHaveTextContent(
        "Failed to create epic",
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByTestId("epic-title-input")).toHaveValue("Direct epic");
  });

  it("opens empty after a successful create instead of reoffering the epic just filed", async () => {
    const fetchMock = mockFetchOk();
    const user = userEvent.setup();
    renderReopenableDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    await user.click(screen.getByTestId("add-user-story"));
    fireEvent.change(screen.getByTestId("user-story-title-input"), {
      target: { value: "First story" },
    });
    fireEvent.click(screen.getByTestId("epic-create-submit"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("epic-create-dialog")).not.toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("reopen"));

    // The success path closes by calling `onOpenChange(false)` directly, so the
    // reset on close never runs for it. Without its own reset the form would
    // reopen holding the epic that was just created, and one more Create files
    // a duplicate epic with duplicate stories.
    await waitFor(() =>
      expect(screen.getByTestId("epic-title-input")).toHaveValue(""),
    );
    expect(screen.queryAllByTestId("user-story-block")).toHaveLength(0);
  });

  it("opens empty after a cancel instead of restoring the abandoned draft", async () => {
    const user = userEvent.setup();
    renderReopenableDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Abandoned epic" },
    });
    await user.click(screen.getByTestId("add-user-story"));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByTestId("epic-create-dialog")).not.toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("reopen"));

    await waitFor(() =>
      expect(screen.getByTestId("epic-title-input")).toHaveValue(""),
    );
    expect(screen.queryAllByTestId("user-story-block")).toHaveLength(0);
  });

  it("ignores Escape while the create is in flight", async () => {
    let settleFetch: (value: unknown) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockReturnValue(new Promise((resolve) => (settleFetch = resolve)));
    global.fetch = fetchMock as unknown as typeof fetch;
    renderReopenableDialog();

    fireEvent.change(screen.getByTestId("epic-title-input"), {
      target: { value: "Direct epic" },
    });
    fireEvent.click(screen.getByTestId("epic-create-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("epic-create-submit")).toBeDisabled(),
    );

    // Cancel is disabled while submitting, but Escape does not go through it —
    // it reaches the dialog directly, so the lock has to live in the handler.
    // Closing here would wipe the draft under a request that is still going to
    // land, and the epic would be created behind a dialog the user dismissed.
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    expect(screen.getByTestId("epic-create-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("epic-title-input")).toHaveValue("Direct epic");

    settleFetch({ ok: true, json: async () => ({ data: { id: "epic-1" } }) });
    await waitFor(() =>
      expect(screen.queryByTestId("epic-create-dialog")).not.toBeInTheDocument(),
    );
  });

  it("puts the caret in the story block it just added", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByTestId("add-user-story"));
    await waitFor(() =>
      expect(screen.getByTestId("user-story-title-input")).toHaveFocus(),
    );

    await user.click(screen.getByTestId("add-user-story"));
    await user.click(screen.getByTestId("add-user-story"));

    // The new block appends to the bottom of the scrolling body. Focus is what
    // brings it into view; landing on the first block would leave the user
    // typing into a story they already filled in.
    const titles = screen.getAllByTestId("user-story-title-input");
    expect(titles).toHaveLength(3);
    await waitFor(() => expect(titles[2]).toHaveFocus());
  });
});
