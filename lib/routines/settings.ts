import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { parsePipelineEnabledSetting } from "@/lib/pipeline/constants";

export const CI_AUTOFIX_ENABLED_SETTING_KEY = "ci_autofix_enabled";

export function ciAutofixEnabledSettingKey(projectId: string): string {
  return `${CI_AUTOFIX_ENABLED_SETTING_KEY}:${projectId}`;
}

/** Project override -> global override -> built-in OFF. */
export function isCiAutofixEnabled(projectId: string): boolean {
  try {
    const projectKey = ciAutofixEnabledSettingKey(projectId);
    const rows = db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        inArray(settings.key, [projectKey, CI_AUTOFIX_ENABLED_SETTING_KEY]),
      )
      .all();
    const byKey = new Map(rows.map((row) => [row.key, row.value]));

    return (
      parsePipelineEnabledSetting(byKey.get(projectKey)) ??
      parsePipelineEnabledSetting(byKey.get(CI_AUTOFIX_ENABLED_SETTING_KEY)) ??
      false
    );
  } catch {
    // A settings read failure must never turn an opt-in code-writing action on.
    return false;
  }
}

/** Persist an explicit project choice, including OFF overriding a global ON. */
export function setCiAutofixEnabled(projectId: string, enabled: boolean): void {
  const key = ciAutofixEnabledSettingKey(projectId);
  const value = JSON.stringify(enabled);
  const updatedAt = new Date().toISOString();
  db.insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt },
    })
    .run();
}
