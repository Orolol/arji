/**
 * Turning an API error payload back into something worth showing a user.
 *
 * `validateBody` answers a rejected body with
 * `{ error: "Validation failed", details: { field: [message, …] } }`. The
 * envelope is right — `error` is the human-readable summary and `details` is
 * the structured part — but a form that renders only `error` tells the user
 * their report was refused and not one word about why. The reasons are in
 * `details`, already phrased for a person by the schema.
 *
 * Client-safe: no `db`, no `zod`, no Next.js import. Takes `unknown`, because
 * what comes back from `res.json()` is whatever the server sent, including
 * `null` from a body that failed to parse.
 */

/** Field messages, flattened in field order and de-duplicated. */
function detailMessages(details: unknown): string[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];

  const messages: string[] = [];

  for (const value of Object.values(details as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    for (const message of value) {
      if (typeof message === "string" && message.trim().length > 0) {
        messages.push(message.trim());
      }
    }
  }

  return [...new Set(messages)];
}

/**
 * The most specific message an error payload carries.
 *
 * Prefers the field-level reasons over the summary, so "Title is required"
 * reaches the user instead of "Validation failed". Falls back to `error`, then
 * to the caller's own wording when the payload says nothing usable.
 */
export function apiErrorMessage(payload: unknown, fallback: string): string {
  const body =
    payload && typeof payload === "object"
      ? (payload as { error?: unknown; details?: unknown })
      : {};

  const details = detailMessages(body.details);
  if (details.length > 0) return details.join(" · ");

  if (typeof body.error === "string" && body.error.trim().length > 0) {
    return body.error.trim();
  }

  return fallback;
}
