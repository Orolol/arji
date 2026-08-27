/**
 * Translating a column's DISPLAY order back into persisted `position` order.
 *
 * Most columns are drawn in `position` order, so a card's display index IS
 * its position and a drag can persist the indices as-is. To Merge is the
 * exception: it is drawn merge-ready-first (see `sortMergeColumn`), so its
 * display index encodes a DERIVED, changing signal.
 *
 * Persisting display indices for such a column would write that signal into
 * `epics.position` — the ordering contract the board, `compareEpics` and the
 * planned unified execution order all read — and would silently reorder cards
 * the user never touched: two To Merge tickets swap in the database as soon
 * as anything is dragged into the column, then visibly swap later when one of
 * them stops being ready.
 *
 * So the rule this module enforces is: **a drag reorders the card that was
 * dragged, and nothing else.** Untouched cards keep their relative position
 * order exactly; only the dragged card is re-ranked.
 *
 * Client-safe by convention (lib/kanban/*): pure, no database, no React.
 */

export interface PositionedCard {
  id: string;
  position: number;
}

/**
 * The order a column's cards should be persisted in, given how they are
 * currently DISPLAYED and which card the user just moved.
 *
 * Untouched cards are returned in their stored `position` order. The moved
 * card is spliced in directly after whichever card precedes it on screen (or
 * at the head when it was dropped at the top).
 *
 * Anchoring to the display PREDECESSOR is a deliberate choice, and it is the
 * one genuinely ambiguous part: when the display order disagrees with the
 * position order, "where the user dropped it" has no single answer in
 * position space. Dropping a card at the visual bottom of a Review column
 * whose last card has a low position therefore lands it mid-list rather than
 * last. That is the acceptable half of the trade; the unacceptable half —
 * rewriting bystanders' positions — is what this function prevents.
 *
 * @param displayed  the column exactly as rendered, moved card included
 * @param movedId    the dragged card, when it landed in THIS column;
 *                   `null` for the column it was dragged out of
 */
export function persistedColumnOrder<T extends PositionedCard>(
  displayed: readonly T[],
  movedId: string | null
): T[] {
  const movedIndex = movedId
    ? displayed.findIndex((card) => card.id === movedId)
    : -1;

  // Ties keep their displayed order: Array.prototype.sort is stable, and a
  // column whose rows share a position (legacy data, a half-applied reorder)
  // must not shuffle on every drag.
  const ordered = displayed
    .filter((_, index) => index !== movedIndex)
    .sort((a, b) => a.position - b.position);

  if (movedIndex === -1) return ordered;

  // The card immediately above the moved one on screen. Ids are unique, so it
  // is always present in `ordered` — it is only excluded when it IS the moved
  // card, which cannot be its own predecessor.
  const anchorId = movedIndex > 0 ? displayed[movedIndex - 1].id : null;
  const anchorIndex = anchorId
    ? ordered.findIndex((card) => card.id === anchorId)
    : -1;

  ordered.splice(anchorIndex + 1, 0, displayed[movedIndex]);
  return ordered;
}
