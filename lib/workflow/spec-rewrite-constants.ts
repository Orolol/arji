/**
 * Client-safe constants for the automatic spec rewrite ("spec vivante").
 *
 * Kept free of database imports so client components (the Settings page)
 * can import the key/parser without pulling server modules into the
 * bundle — same pattern as lib/documents/memory-constants.ts.
 */

/**
 * Settings key for the automatic spec rewrite: when the stored value parses
 * to `true`, publishing a release enqueues a plan-mode agent session that
 * rewrites `projects.spec` to reflect the project's current reality.
 * DEFAULT OFF — absent key means disabled.
 */
export const SPEC_AUTO_REWRITE_SETTING_KEY = "spec_auto_rewrite";

/** Tolerant parse of the settings row value ('true'/'false', default off). */
export function parseSpecAutoRewriteSetting(value: unknown): boolean {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // raw (non-JSON) string — compare as-is below
    }
  }
  if (parsed === true) return true;
  if (typeof parsed === "string") return parsed.trim().toLowerCase() === "true";
  return false;
}
