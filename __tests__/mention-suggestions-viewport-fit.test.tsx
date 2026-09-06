/**
 * B-arij-181 — the `@ cite un doc` suggestion list overflows the bottom of the
 * window on the desktop chat frame.
 *
 * `MentionTextarea` rendered its menu `absolute mt-1` — always *under* the
 * field, in flow, with no placement decision at all. On `/chat` the composer is
 * anchored to the bottom of a page that does not scroll vertically, so at
 * 1440x1000 and 1280x800 the popover was measured in Chrome at top 988.1 /
 * bottom 1090.4: 90.4px of a 102.3px list off-screen, with no scroll to catch
 * it. `max-h-48` (192px) makes it worse the more documents a project has.
 *
 * The contract these tests pin is not "opens upward" but "fits in the
 * viewport": the menu picks the side that has room, and clamps its height to
 * the room that side actually has. jsdom has no layout, so the geometry is
 * stubbed (anchor rect, natural list height, window height) and the resulting
 * placement is checked against the projected on-screen box. The pixel claim
 * itself belongs to the browser pass, not here.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { MentionTextarea } from "@/components/documents/MentionTextarea";

const DOCS = [
  { id: "d1", originalFilename: "alpha.md" },
  { id: "d2", originalFilename: "beta.md" },
  { id: "d3", originalFilename: "gamma.md" },
];

/** `mt-1` / `mb-1` — the gap the menu keeps from the field. */
const GAP = 4;

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: DOCS }) });
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreScrollHeight?.();
  restoreScrollHeight = null;
});

let restoreScrollHeight: (() => void) | null = null;

function Harness() {
  const [value, setValue] = useState("");
  return (
    <MentionTextarea
      projectId="p1"
      value={value}
      onValueChange={setValue}
      aria-label="Message"
    />
  );
}

function field() {
  return screen.getByLabelText("Message") as HTMLTextAreaElement;
}

/** The wrapper the popover is positioned against. */
function anchor(): HTMLElement {
  return field().parentElement as HTMLElement;
}

/**
 * The positioned popover, found by walking up from a suggestion to the child
 * of the anchor. Deliberately structural rather than by test id: it resolves
 * on the unfixed component too, so a red run here means "no placement
 * decision", not "no test hook".
 */
function menu(): HTMLElement {
  let node = screen.getByRole("button", { name: "alpha.md" }) as HTMLElement;
  while (node.parentElement && node.parentElement !== anchor()) {
    node = node.parentElement;
  }
  return node;
}

interface Frame {
  /** Window height in CSS pixels. */
  viewportHeight: number;
  /** Where the composer's field sits in that window. */
  anchorTop: number;
  anchorBottom: number;
  /** Natural height of the rendered list. */
  listHeight: number;
}

function stubGeometry({ viewportHeight, anchorTop, anchorBottom, listHeight }: Frame) {
  Object.defineProperty(window, "innerHeight", {
    value: viewportHeight,
    configurable: true,
    writable: true,
  });

  const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (document.body.contains(this) && this === anchor()) {
      return {
        ...zero,
        top: anchorTop,
        bottom: anchorBottom,
        height: anchorBottom - anchorTop,
      } as DOMRect;
    }
    return { ...zero, toJSON: () => zero } as DOMRect;
  });

  // jsdom reports 0 for every scroll box; the menu's natural height is what
  // decides whether the space below is enough.
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      try {
        if (document.body.contains(this) && this === menu()) return listHeight;
      } catch {
        // no menu open
      }
      return 0;
    },
  });
  restoreScrollHeight = () => {
    if (original) Object.defineProperty(Element.prototype, "scrollHeight", original);
  };
}

async function openSuggestions() {
  await act(async () => {
    render(<Harness />);
  });
  await userEvent.type(field(), "@");
  expect(await screen.findByRole("button", { name: "alpha.md" })).toBeInTheDocument();
}

/** The box the menu will occupy on screen, from its placement and clamp. */
function projectedBox(frame: Frame) {
  const el = menu();
  const placement = el.getAttribute("data-placement");
  const maxHeight = Number.parseFloat(el.style.maxHeight || "NaN");
  expect(["above", "below"], "the menu declares no placement").toContain(placement);
  expect(Number.isFinite(maxHeight), "the menu declares no height clamp").toBe(true);

  const height = Math.min(frame.listHeight, maxHeight);
  return placement === "above"
    ? { placement, maxHeight, top: frame.anchorTop - GAP - height, bottom: frame.anchorTop - GAP }
    : { placement, maxHeight, top: frame.anchorBottom + GAP, bottom: frame.anchorBottom + GAP + height };
}

describe("the @ suggestion list on the one-row desktop composer", () => {
  // The two frames the ticket measured in Chrome: the band fits on one row, so
  // the field sits at the very bottom of a page that does not scroll.
  const oneRowFrames: Array<[string, Frame]> = [
    ["1440 x 1000", { viewportHeight: 1000, anchorTop: 950, anchorBottom: 984, listHeight: 102 }],
    ["1280 x 800", { viewportHeight: 800, anchorTop: 750, anchorBottom: 784, listHeight: 102 }],
  ];

  it.each(oneRowFrames)("opens upward at %s rather than off the bottom", async (_label, frame) => {
    stubGeometry(frame);
    await openSuggestions();

    const box = projectedBox(frame);
    expect(box.placement).toBe("above");
    expect(menu().className).toContain("bottom-full");
    expect(menu().className).not.toContain("top-full");
    expect(box.bottom).toBeLessThanOrEqual(frame.viewportHeight);
    expect(box.top).toBeGreaterThanOrEqual(0);
  });
});

describe("the @ suggestion list where the composer already has room", () => {
  // Since B-arij-180 the band wraps to two rows below 36rem, which lifts the
  // field; the ticket measured the popover fully inside the viewport there.
  // Flipping it upward would be a regression, so this is the control.
  const roomyFrames: Array<[string, Frame]> = [
    ["390 x 844, wrapped band", { viewportHeight: 844, anchorTop: 683, anchorBottom: 717, listHeight: 102 }],
    ["1024 x 768, wrapped band", { viewportHeight: 768, anchorTop: 600, anchorBottom: 634, listHeight: 102 }],
    ["a field near the top of the page", { viewportHeight: 800, anchorTop: 120, anchorBottom: 154, listHeight: 102 }],
  ];

  it.each(roomyFrames)("stays below the field at %s", async (_label, frame) => {
    stubGeometry(frame);
    await openSuggestions();

    const box = projectedBox(frame);
    expect(box.placement).toBe("below");
    expect(menu().className).toContain("top-full");
    expect(box.bottom).toBeLessThanOrEqual(frame.viewportHeight);
  });
});

describe("the @ suggestion list when neither side has 192px", () => {
  it("clamps to the taller side instead of overflowing it", async () => {
    // A short window with the field in the middle: 90px above, 60px below, and
    // a project with enough documents to want the full `max-h-48`.
    const frame: Frame = {
      viewportHeight: 300,
      anchorTop: 94,
      anchorBottom: 236,
      listHeight: 192,
    };
    stubGeometry(frame);
    await openSuggestions();

    const box = projectedBox(frame);
    expect(box.placement).toBe("above");
    expect(box.maxHeight).toBeLessThanOrEqual(frame.anchorTop - GAP);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(frame.viewportHeight);
  });
});
