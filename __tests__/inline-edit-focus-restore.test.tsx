import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineEdit } from "@/components/kanban/InlineEdit";
import { StoryDetailPanel } from "@/components/story/StoryDetailPanel";

/**
 * Naming the InlineEdit read state made it a keyboard-reachable activation
 * target. That is what the label-association fix needed, but it also created a
 * focus-order obligation the first pass did not honour: every exit from edit
 * mode unmounts the focused <textarea>/<input>, and focus fell to <body>.
 *
 * The failure is WCAG 2.4.3 (Focus Order) and it bites the exact journey the
 * ticket exists to enable — tab to the field, Enter, edit, Escape — because
 * the next Tab then restarts at the top of the document.
 *
 * Restoration is deliberately scoped to *keyboard* exits. A blur caused by
 * clicking or tabbing elsewhere is the user moving focus on purpose, and
 * yanking it back would be its own bug; the last two cases pin that boundary.
 */

const story = {
  id: "story-1",
  epicId: "epic-1",
  title: "Ship the label fix",
  description: "The panel must name its fields.",
  acceptanceCriteria: "Given a screen reader, when the panel opens, then...",
  status: "todo",
  position: 0,
  createdAt: "2026-09-05T10:00:00.000Z",
  epic: null,
};

/**
 * A single-line InlineEdit named the way its real callers name it — a visible
 * label pointing at the control — so the accessible queries below exercise the
 * association rather than a test-only `aria-label` the component never ships.
 */
function LabelledInlineEdit({
  onSave = vi.fn(),
  after = false,
}: {
  onSave?: (value: string) => void;
  after?: boolean;
}) {
  return (
    <>
      <label id="title-label" htmlFor="title-field">
        Title
      </label>
      <InlineEdit
        id="title-field"
        aria-labelledby="title-label"
        value="original"
        onSave={onSave}
      />
      {after && (
        <button type="button" data-testid="after">
          after
        </button>
      )}
    </>
  );
}

describe("InlineEdit focus restoration", () => {
  it("returns focus to the field after Escape cancels an edit", async () => {
    const user = userEvent.setup();
    render(<StoryDetailPanel story={story} onUpdate={vi.fn()} />);

    const field = screen.getByRole("button", { name: "Description" });
    field.focus();
    await user.keyboard("{Enter}");

    const editor = screen.getByLabelText("Description");
    expect(editor.tagName).toBe("TEXTAREA");
    expect(editor).toHaveFocus();

    await user.keyboard("{Escape}");

    // The read state is back, and focus is on it — not on <body>, which would
    // send the next Tab to the top of the page.
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: "Description" })).toHaveFocus();
  });

  it("returns focus to the field after Enter saves a single-line edit", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<LabelledInlineEdit onSave={onSave} />);

    screen.getByRole("button", { name: "Title" }).focus();
    await user.keyboard("{Enter}");

    const editor = screen.getByRole("textbox");
    expect(editor).toHaveFocus();
    await user.clear(editor);
    await user.type(editor, "renamed");
    await user.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith("renamed");
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("button", { name: "Title" })).toHaveFocus();
  });

  it("keeps the field reachable by Tab after an Escape round trip", async () => {
    const user = userEvent.setup();
    render(<LabelledInlineEdit after />);

    screen.getByRole("button", { name: "Title" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");

    // Focus order is intact: the very next Tab lands on the following control
    // rather than restarting from the top of the document.
    await user.tab();
    expect(screen.getByTestId("after")).toHaveFocus();
  });

  /**
   * The boundary. Blur means the user aimed somewhere else; restoring focus
   * there would fight them. Both cases must leave focus where the user put it.
   */
  it("does not yank focus back when the user clicks another control away", async () => {
    const user = userEvent.setup();
    render(<LabelledInlineEdit after />);

    screen.getByRole("button", { name: "Title" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox")).toHaveFocus();

    await user.click(screen.getByTestId("after"));

    expect(screen.getByTestId("after")).toHaveFocus();
  });

  it("does not yank focus back when the user tabs out of the editor", async () => {
    const user = userEvent.setup();
    render(<LabelledInlineEdit after />);

    screen.getByRole("button", { name: "Title" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox")).toHaveFocus();

    await user.tab();

    expect(screen.getByTestId("after")).toHaveFocus();
  });
});
