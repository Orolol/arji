import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StoryDetailPanel } from "@/components/story/StoryDetailPanel";
import {
  THEMES,
  classTokens,
  colorPaints,
  resolveFocusVisibleOutline,
} from "./helpers/tailwind-outline";

/**
 * The story detail panel carried the same defect class as the QA dialog: a
 * visual <label> with no `htmlFor` that wrapped no control, plus one <label>
 * whose whole content was `&nbsp;` and which named nothing at all — it only
 * pushed the status badge down to line up with the select beside it.
 *
 * Description and Acceptance Criteria are `InlineEdit` fields, so they have two
 * states: a click-to-edit region and, once activated, a real textarea. Both
 * states are asserted — naming only the textarea would leave the field
 * anonymous in the state a user actually lands on.
 *
 * Everything is queried through the accessible name on purpose; a test-id
 * query would pass while the association stayed broken.
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

function renderPanel() {
  return render(<StoryDetailPanel story={story} onUpdate={vi.fn()} />);
}

describe("Story detail panel accessibility", () => {
  it("names the status select through its visible label", () => {
    renderPanel();

    expect(screen.getByLabelText("Status")).toBe(
      screen.getByRole("combobox", { name: "Status" }),
    );
  });

  it("names the description field in its read state", () => {
    renderPanel();

    const field = screen.getByRole("button", { name: "Description" });
    expect(field).toHaveTextContent("The panel must name its fields.");
    expect(screen.getByLabelText("Description")).toBe(field);
  });

  it("names the acceptance criteria field in its read state", () => {
    renderPanel();

    const field = screen.getByRole("button", { name: "Acceptance Criteria" });
    expect(field).toHaveTextContent(
      "Given a screen reader, when the panel opens, then...",
    );
    expect(screen.getByLabelText("Acceptance Criteria")).toBe(field);
  });

  it("keeps the description named once it becomes an editable textarea", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Description" }));

    const textarea = screen.getByLabelText("Description");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveValue("The panel must name its fields.");
  });

  it("opens the description editor from the keyboard", () => {
    renderPanel();

    const field = screen.getByRole("button", { name: "Description" });
    expect(field).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(field, { key: "Enter" });

    expect(screen.getByLabelText("Description").tagName).toBe("TEXTAREA");
  });

  /**
   * Naming the field put it in the tab order, so it now owes the reader a
   * visible focus ring. Asserted as a RESOLVED outline rather than as a class
   * name: `focus-visible:outline-2` sitting next to an `outline-none` paints
   * nothing at all in Tailwind v4, and a class-presence assertion passes on
   * exactly that bug (B-arij-JJ5FdaHpX7d6). Not a browser — `e2e/focus-ring.spec.ts`
   * is what measures a ring on screen.
   */
  it("paints a focus ring on the field it just made focusable", async () => {
    renderPanel();

    const field = screen.getByRole("button", { name: "Description" });
    const resolved = await resolveFocusVisibleOutline(
      classTokens(field.className),
    );

    expect(resolved.paints).toBe(true);
    expect(resolved.style).toBe("solid");
    expect(resolved.width).toBe("2px");
    // And a colour that is not transparent, in either theme — resolved from
    // app/globals.css (`focus-ring-color.test.ts` pins the mechanism).
    for (const theme of THEMES) {
      expect(
        colorPaints(resolved.colorIn[theme]),
        `outline-color resolves to ${resolved.colorIn[theme]} in ${theme}`,
      ).toBe(true);
    }
  });

  it("leaves no label in the panel that names nothing", () => {
    const { container } = renderPanel();

    const orphans = Array.from(container.querySelectorAll("label")).filter(
      (label) =>
        !label.getAttribute("for") &&
        !label.querySelector(
          "button, input, meter, output, progress, select, textarea",
        ),
    );

    expect(orphans.map((label) => label.textContent)).toEqual([]);
  });

  // Control: the badge that the `&nbsp;` spacer label used to align must still
  // be rendered, so replacing that label with a plain spacer is proven not to
  // have dropped the element it was there to position. "To Do" appears twice —
  // once as the select's value, once as the badge — on both sides of the fix.
  it("still renders the status badge beside the select", () => {
    renderPanel();

    expect(screen.getAllByText("To Do")).toHaveLength(2);
  });
});
