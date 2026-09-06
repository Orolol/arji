/**
 * Where the `@ cite un doc` suggestion list goes, and how tall it is allowed to
 * be.
 *
 * The list used to be `absolute mt-1` with no placement decision — always under
 * the field, in flow. On `/chat` the composer is anchored to the bottom of a
 * page that does not scroll vertically, so on the frames where the band fits on
 * one row (1280, 1440) the popover was measured in Chrome at bottom 1090.4 in a
 * 1000px window: 90.4px of a 102.3px list off-screen with no scroll to catch
 * it, and worse the more documents the project has.
 *
 * The rule is deliberately geometric and pure so the component only has to feed
 * it three measurements: it picks the side with room, and clamps the menu to
 * the room that side actually has, so the box is inside the viewport on both
 * axes of the decision.
 */

/** `mt-1` / `mb-1` — the gap the menu keeps from the field. */
export const MENTION_MENU_GAP = 4;

/** The former `max-h-48`: the list never grows past this, room or not. */
export const MENTION_MENU_MAX_HEIGHT = 192;

export type MentionMenuPlacement = "above" | "below";

export interface MentionMenuFit {
  placement: MentionMenuPlacement;
  maxHeight: number;
}

export interface MentionMenuGeometry {
  /** Top of the field, in viewport coordinates. */
  anchorTop: number;
  /** Bottom of the field, in viewport coordinates. */
  anchorBottom: number;
  viewportHeight: number;
  /**
   * Natural height of the list. `0` means "not laid out yet" (the first pass,
   * and every jsdom render), and is read as "assume it wants the full height" —
   * conservative, never a claim that the list is empty.
   */
  contentHeight: number;
}

/** The fit used before anything has been measured, and when there is nothing to measure against. */
export const DEFAULT_MENTION_MENU_FIT: MentionMenuFit = {
  placement: "below",
  maxHeight: MENTION_MENU_MAX_HEIGHT,
};

export function resolveMentionMenuFit({
  anchorTop,
  anchorBottom,
  viewportHeight,
  contentHeight,
}: MentionMenuGeometry): MentionMenuFit {
  // No viewport to fit into (SSR, a detached node): keep the historical
  // placement rather than inventing a flip from zeroes.
  if (!(viewportHeight > 0)) return DEFAULT_MENTION_MENU_FIT;

  const spaceBelow = Math.max(0, viewportHeight - anchorBottom - MENTION_MENU_GAP);
  const spaceAbove = Math.max(0, anchorTop - MENTION_MENU_GAP);

  const wanted =
    contentHeight > 0
      ? Math.min(contentHeight, MENTION_MENU_MAX_HEIGHT)
      : MENTION_MENU_MAX_HEIGHT;

  // Below is the default and only loses when it cannot hold the list AND the
  // other side holds more of it — a flip that gains nothing is just movement.
  if (spaceBelow >= wanted || spaceBelow >= spaceAbove) {
    return { placement: "below", maxHeight: Math.min(MENTION_MENU_MAX_HEIGHT, spaceBelow) };
  }

  return { placement: "above", maxHeight: Math.min(MENTION_MENU_MAX_HEIGHT, spaceAbove) };
}
