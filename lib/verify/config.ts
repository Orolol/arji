import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import {
  DEFAULT_VERIFY_COMMANDS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  VERIFY_COMMANDS_SETTING_KEY,
  VERIFY_TIMEOUT_MS_SETTING_KEY,
  parseVerifyCommands,
  parseVerifyTimeoutMs,
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
  const commandKeys = [
    verifyCommandsSettingKey(projectId),
    VERIFY_COMMANDS_SETTING_KEY,
  ];
  const timeoutKeys = [
    verifyTimeoutMsSettingKey(projectId),
    VERIFY_TIMEOUT_MS_SETTING_KEY,
  ];

  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [...commandKeys, ...timeoutKeys]))
    .all();
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const firstParsed = <T>(
    keys: readonly string[],
    parse: (value: unknown) => T | null,
    fallback: T
  ): T => {
    for (const key of keys) {
      if (!map.has(key)) continue;
      const parsed = parse(map.get(key));
      if (parsed !== null) return parsed;
    }
    return fallback;
  };

  const commands = firstParsed(
    commandKeys,
    parseVerifyCommands,
    DEFAULT_VERIFY_COMMANDS
  );

  return {
    enabled: commands.length > 0,
    commands,
    timeoutMs: firstParsed(
      timeoutKeys,
      parseVerifyTimeoutMs,
      DEFAULT_VERIFY_TIMEOUT_MS
    ),
  };
}
