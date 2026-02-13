/**
 * Format elapsed time from a start date to a human-readable string.
 *
 * - Under 60s: "Xs"
 * - Under 60m: "Xm Ys"
 * - Over 60m: "Xh Ym"
 */
export function formatElapsed(startedAt: string | Date, now?: Date): string {
  const start =
    typeof startedAt === "string" ? new Date(startedAt) : startedAt;
  const current = now ?? new Date();
  const totalSeconds = Math.max(
    0,
    Math.floor((current.getTime() - start.getTime()) / 1000),
  );

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes < 60) {
    const secs = totalSeconds % 60;
    return `${totalMinutes}m ${secs}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}h ${mins}m`;
}
