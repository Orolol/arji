import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

/** Global opt-in for best-effort screenshot instructions in build prompts. */
export const VISUAL_PROOF_ENABLED_SETTING_KEY = "visual_proof_enabled";

/**
 * Parse the setting without collapsing an invalid or absent value into an
 * override. `null` is the unconfigured state; the built-in default is OFF.
 */
export function parseVisualProofEnabledSetting(
  value: unknown
): boolean | null {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // Legacy bare strings are compared below.
    }
  }

  if (parsed === true) return true;
  if (parsed === false) return false;
  if (typeof parsed === "string") {
    const normalized = parsed.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

/** Read the global tri-state setting. Missing or malformed means OFF. */
export function isVisualProofEnabled(): boolean {
  try {
    const row = db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, VISUAL_PROOF_ENABLED_SETTING_KEY))
      .get();

    return row
      ? (parseVisualProofEnabledSetting(row.value) ?? false)
      : false;
  } catch {
    // Prompt creation must remain usable if settings cannot be read. Since
    // visual proof is opt-in and non-blocking, the safe fallback is OFF.
    return false;
  }
}
