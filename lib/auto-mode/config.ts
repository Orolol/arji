import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, settings } from "@/lib/db/schema";
import {
  AUTO_MODE_BUILD_AGENT_SETTING_KEY,
  AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY,
  AUTO_MODE_ENABLED_SETTING_KEY,
  AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
  AUTO_MODE_REVIEW_CONCURRENCY_SETTING_KEY,
  AUTO_MODE_SMART_DISPATCH_SETTING_KEY,
  FULL_AUTO_SECOND_OPINION_SETTING_KEY,
  DEFAULT_AUTO_BUILD_CONCURRENCY,
  DEFAULT_AUTO_REVIEW_CONCURRENCY,
  autoModeBuildAgentSettingKey,
  autoModeBuildConcurrencySettingKey,
  autoModeEnabledSettingKey,
  autoModeReviewAgentSettingKey,
  autoModeReviewConcurrencySettingKey,
  autoModeSmartDispatchSettingKey,
  fullAutoSecondOpinionSettingKey,
  parseAutoModeAgent,
  parseAutoModeConcurrency,
  parseAutoModeEnabled,
  type AutoModeConfig,
} from "./constants";

/**
 * Server-side resolver for the Full Auto Mode configuration — the direct
 * counterpart of `resolveMaxConcurrentForProject` (lib/agents/scheduler.ts):
 * per-project key → global key → built-in default, one level at a time.
 *
 * Deliberately NOT cached. The sweep calls this on every tick, so flipping
 * the switch or retuning a budget in the dialog takes effect on the next
 * sweep without a server restart — the same posture the scheduler takes with
 * its budget and the watchdog with its thresholds.
 */

/** The fourteen keys the resolver may need, read in a single query per call. */
function readSettingsMap(projectId: string): Map<string, string> {
  const keys = [
    autoModeEnabledSettingKey(projectId),
    AUTO_MODE_ENABLED_SETTING_KEY,
    autoModeBuildAgentSettingKey(projectId),
    AUTO_MODE_BUILD_AGENT_SETTING_KEY,
    autoModeBuildConcurrencySettingKey(projectId),
    AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY,
    autoModeReviewAgentSettingKey(projectId),
    AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
    autoModeReviewConcurrencySettingKey(projectId),
    AUTO_MODE_REVIEW_CONCURRENCY_SETTING_KEY,
    autoModeSmartDispatchSettingKey(projectId),
    AUTO_MODE_SMART_DISPATCH_SETTING_KEY,
    fullAutoSecondOpinionSettingKey(projectId),
    FULL_AUTO_SECOND_OPINION_SETTING_KEY,
  ];

  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys))
    .all();

  return new Map(rows.map((row) => [row.key, row.value]));
}

/**
 * Effective Full Auto Mode configuration for a project. Re-read from the
 * settings table on every call.
 */
export function resolveAutoModeConfigForProject(
  projectId: string
): AutoModeConfig {
  const map = readSettingsMap(projectId);

  const pick = <T>(
    perProjectKey: string,
    globalKey: string,
    parse: (value: unknown) => T | null,
    fallback: T
  ): T => {
    for (const key of [perProjectKey, globalKey]) {
      if (!map.has(key)) continue;
      const parsed = parse(map.get(key));
      if (parsed !== null) return parsed;
    }
    return fallback;
  };

  return {
    enabled: pick(
      autoModeEnabledSettingKey(projectId),
      AUTO_MODE_ENABLED_SETTING_KEY,
      parseAutoModeEnabled,
      false
    ),
    buildAgent: pick(
      autoModeBuildAgentSettingKey(projectId),
      AUTO_MODE_BUILD_AGENT_SETTING_KEY,
      parseAutoModeAgent,
      null
    ),
    buildConcurrency: pick(
      autoModeBuildConcurrencySettingKey(projectId),
      AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY,
      parseAutoModeConcurrency,
      DEFAULT_AUTO_BUILD_CONCURRENCY
    ),
    reviewAgent: pick(
      autoModeReviewAgentSettingKey(projectId),
      AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
      parseAutoModeAgent,
      null
    ),
    reviewConcurrency: pick(
      autoModeReviewConcurrencySettingKey(projectId),
      AUTO_MODE_REVIEW_CONCURRENCY_SETTING_KEY,
      parseAutoModeConcurrency,
      DEFAULT_AUTO_REVIEW_CONCURRENCY
    ),
    smartDispatch: pick(
      autoModeSmartDispatchSettingKey(projectId),
      AUTO_MODE_SMART_DISPATCH_SETTING_KEY,
      parseAutoModeEnabled,
      false
    ),
    secondOpinion: pick(
      fullAutoSecondOpinionSettingKey(projectId),
      FULL_AUTO_SECOND_OPINION_SETTING_KEY,
      parseAutoModeEnabled,
      false
    ),
  };
}

/**
 * Every project that has Full Auto Mode switched on right now.
 *
 * The standing sweep has no request context, so it discovers its own work
 * list. It MUST use the same project → global → default chain
 * `resolveAutoModeConfigForProject` uses, or the UI would report a project as
 * enabled while the supervisor silently never swept it: with a global
 * `auto_mode_enabled` of true, a project with no key of its own is enabled,
 * and reading only `auto_mode_enabled:<projectId>` rows would miss it.
 *
 * So: start from the projects table when the global key is on, and from the
 * per-project keys otherwise (the overwhelmingly common case, which costs one
 * settings scan and no project query).
 */
export function listAutoModeEnabledProjectIds(): string[] {
  const prefix = `${AUTO_MODE_ENABLED_SETTING_KEY}:`;
  const rows = db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .all();

  const globalDefault =
    parseAutoModeEnabled(
      rows.find((row) => row.key === AUTO_MODE_ENABLED_SETTING_KEY)?.value
    ) === true;

  const perProject = new Map<string, boolean>();
  for (const row of rows) {
    if (!row.key.startsWith(prefix)) continue;
    const projectId = row.key.slice(prefix.length);
    if (!projectId) continue;
    const parsed = parseAutoModeEnabled(row.value);
    if (parsed !== null) perProject.set(projectId, parsed);
  }

  if (!globalDefault) {
    return Array.from(perProject.entries())
      .filter(([, enabled]) => enabled)
      .map(([projectId]) => projectId);
  }

  // Global ON: every project except those that opted out explicitly.
  return db
    .select({ id: projects.id })
    .from(projects)
    .all()
    .map((row) => row.id)
    .filter((projectId) => perProject.get(projectId) !== false);
}
