import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import {
  VERIFY_COMMANDS_SETTING_KEY,
  VERIFY_TIMEOUT_MS_SETTING_KEY,
  resolveVerifyConfig,
  verifyCommandsSettingKey,
  verifyTimeoutMsSettingKey,
  type VerifyConfig,
} from "./verify-constants";

/**
 * Resolve deterministic verification settings directly from SQLite.
 *
 * Settings are intentionally re-read for each invocation so a human edit is
 * visible to the next verification run without restarting Arij. Each value
 * independently follows project override -> global setting -> built-in
 * default. No configured commands means verification is disabled.
 */
export function resolveVerifyConfigForProject(projectId: string): VerifyConfig {
  const keys = [
    verifyCommandsSettingKey(projectId),
    VERIFY_COMMANDS_SETTING_KEY,
    verifyTimeoutMsSettingKey(projectId),
    VERIFY_TIMEOUT_MS_SETTING_KEY,
  ];

  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys))
    .all();

  return resolveVerifyConfig(
    Object.fromEntries(rows.map((row) => [row.key, row.value])),
    projectId
  );
}
