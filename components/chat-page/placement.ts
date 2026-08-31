/**
 * Where a ticket landed, in words — the epic card's `créé dans To Do · #3` and
 * the rail's shorter `To Do #4`.
 *
 * `null` in, `null` out: the caller prints an em-dash. A placement we cannot
 * resolve is never invented, and never a zero-rank.
 */

/** The in-thread card's note. */
export function longPlacement(
  status: string | null | undefined,
  rank: number | null | undefined,
): string | null {
  if (!status) return null;
  if (status === "todo") {
    return rank !== null && rank !== undefined
      ? `créé dans To Do · #${rank}`
      : "créé dans To Do";
  }
  if (status === "backlog") return "créé dans Backlog";
  // Anything else is the status word alone rather than a phrase we made up.
  return status;
}

/** The "Créé dans ce chat" rail's note. */
export function shortPlacement(
  status: string | null | undefined,
  rank: number | null | undefined,
): string | null {
  if (!status) return null;
  if (status === "todo") {
    return rank !== null && rank !== undefined ? `To Do #${rank}` : "To Do";
  }
  if (status === "backlog") return "Backlog";
  return status;
}
