const SQLITE_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * Parse the two UTC timestamp shapes stored by Arij: explicit ISO strings and
 * SQLite CURRENT_TIMESTAMP values. Date.parse treats the latter as local
 * time, so make their UTC origin explicit before comparing them.
 */
function parseStoredTimestamp(value: string): number | null {
  const trimmed = value.trim();
  const sqliteMatch = trimmed.match(SQLITE_TIMESTAMP_RE);
  const normalized = sqliteMatch
    ? `${sqliteMatch[1]}T${sqliteMatch[2]}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Return the newest valid activity timestamp in a stable ISO representation.
 * Invalid legacy values are ignored instead of making the whole session
 * unsortable.
 */
export function latestActivityTimestamp(
  ...values: Array<string | null | undefined>
): string | null {
  let latestMs: number | null = null;

  for (const value of values) {
    if (!value) continue;
    const parsed = parseStoredTimestamp(value);
    if (parsed === null) continue;
    if (latestMs === null || parsed > latestMs) latestMs = parsed;
  }

  return latestMs === null ? null : new Date(latestMs).toISOString();
}
