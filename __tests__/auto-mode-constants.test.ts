/**
 * Tests for the Full Auto Mode configuration layer:
 *   - lib/auto-mode/constants.ts — the client-safe keys, clamps and parsers
 *   - lib/auto-mode/config.ts    — the server-side project → global → default
 *                                  fall-through chain against a real settings
 *                                  table
 *
 * The parsers have to swallow both raw values and the JSON-encoded forms
 * PATCH /api/settings writes (`JSON.stringify` on every value), so each one
 * is exercised through both shapes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { projects, settings } = await import("@/lib/db/schema");
const {
  AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY,
  AUTO_MODE_CONCURRENCY_RANGE,
  AUTO_MODE_REASONS,
  AUTO_MODE_ENABLED_SETTING_KEY,
  AUTO_MODE_REASON_PREFIX,
  AUTO_MODE_REVIEW_CONCURRENCY_SETTING_KEY,
  AUTO_MODE_SMART_DISPATCH_SETTING_KEY,
  AUTO_MODE_SWEEP_INTERVAL_MS,
  AUTO_RUN_ID_PREFIX,
  DEFAULT_AUTO_BUILD_CONCURRENCY,
  DEFAULT_AUTO_REVIEW_CONCURRENCY,
  autoModeBuildAgentSettingKey,
  autoModeBuildConcurrencySettingKey,
  autoModeEnabledSettingKey,
  autoModeReviewAgentSettingKey,
  autoModeReviewConcurrencySettingKey,
  autoModeSmartDispatchSettingKey,
  autoRunId,
  isAutoModeActivityReason,
  isAutoRunId,
  parseAutoModeAgent,
  parseAutoModeConcurrency,
  parseAutoModeEnabled,
  resolveAutoModeConfig,
} = await import("@/lib/auto-mode/constants");
const { NIGHT_RUN_ID_PREFIX, isNightRunId } = await import(
  "@/lib/night/constants"
);
const { resolveAutoModeConfigForProject, listAutoModeEnabledProjectIds } =
  await import("@/lib/auto-mode/config");

/** Writes a settings row exactly the way PATCH /api/settings would. */
function putSetting(key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value) },
    })
    .run();
}

beforeEach(() => {
  db.delete(settings).run();
  db.delete(projects).run();
});

describe("auto-mode setting keys", () => {
  it("exposes a global key plus a <key>:<projectId> per-project override", () => {
    expect(AUTO_MODE_ENABLED_SETTING_KEY).toBe("auto_mode_enabled");
    expect(autoModeEnabledSettingKey("p1")).toBe("auto_mode_enabled:p1");
    expect(autoModeBuildAgentSettingKey("p1")).toBe("auto_mode_build_agent:p1");
    expect(autoModeBuildConcurrencySettingKey("p1")).toBe(
      "auto_mode_build_concurrency:p1"
    );
    expect(autoModeReviewAgentSettingKey("p1")).toBe(
      "auto_mode_review_agent:p1"
    );
    expect(autoModeSmartDispatchSettingKey("p1")).toBe(
      "auto_mode_smart_dispatch:p1"
    );
    expect(AUTO_MODE_SMART_DISPATCH_SETTING_KEY).toBe(
      "auto_mode_smart_dispatch"
    );
    expect(autoModeReviewConcurrencySettingKey("p1")).toBe(
      "auto_mode_review_concurrency:p1"
    );
  });

  it("pins the sweep cadence and the defaults", () => {
    expect(AUTO_MODE_SWEEP_INTERVAL_MS).toBe(15_000);
    expect(DEFAULT_AUTO_BUILD_CONCURRENCY).toBe(2);
    expect(DEFAULT_AUTO_REVIEW_CONCURRENCY).toBe(1);
    expect(AUTO_MODE_CONCURRENCY_RANGE).toEqual({ min: 0, max: 10 });
  });

  it("uses a run-id prefix that cannot collide with night runs", () => {
    expect(AUTO_RUN_ID_PREFIX).toBe("auto_");
    expect(autoRunId("proj1")).toBe("auto_proj1");
    expect(isAutoRunId(autoRunId("proj1"))).toBe(true);
    expect(isAutoRunId(`${NIGHT_RUN_ID_PREFIX}abc`)).toBe(false);
    expect(isNightRunId(autoRunId("proj1"))).toBe(false);
    expect(isAutoRunId(null)).toBe(false);
  });

  it("prefixes every activity reason with 'Auto mode '", () => {
    expect(AUTO_MODE_REASON_PREFIX).toBe("Auto mode ");
    expect(isAutoModeActivityReason("Auto mode dispatched a review")).toBe(true);
    expect(isAutoModeActivityReason("Pipeline started")).toBe(false);
    expect(isAutoModeActivityReason(null)).toBe(false);
  });

  it("recognises EVERY reason it emits, including the colon form", () => {
    // "Auto mode: review clean, merged" reads as a label, not a sentence —
    // and the successful auto-merge is the entry the feed most needs to show.
    expect(isAutoModeActivityReason(AUTO_MODE_REASONS.merged)).toBe(true);

    const emitted = Object.values(AUTO_MODE_REASONS).map((reason) =>
      typeof reason === "function"
        ? reason(1 as never, "x" as never, 1 as never, 1 as never)
        : reason
    );
    for (const reason of emitted) {
      expect(isAutoModeActivityReason(reason)).toBe(true);
    }
  });
});

describe("parseAutoModeEnabled", () => {
  it("accepts raw booleans, bare strings and JSON-encoded strings", () => {
    expect(parseAutoModeEnabled(true)).toBe(true);
    expect(parseAutoModeEnabled(false)).toBe(false);
    expect(parseAutoModeEnabled("true")).toBe(true);
    expect(parseAutoModeEnabled("false")).toBe(false);
    expect(parseAutoModeEnabled(JSON.stringify(true))).toBe(true);
    expect(parseAutoModeEnabled(JSON.stringify(false))).toBe(false);
  });

  it("returns null for anything unconfigured or unparseable", () => {
    expect(parseAutoModeEnabled(undefined)).toBeNull();
    expect(parseAutoModeEnabled(null)).toBeNull();
    expect(parseAutoModeEnabled("")).toBeNull();
    expect(parseAutoModeEnabled("yes")).toBeNull();
    expect(parseAutoModeEnabled(1)).toBeNull();
  });
});

describe("parseAutoModeConcurrency", () => {
  it("accepts numbers, numeric strings and JSON-encoded numbers", () => {
    expect(parseAutoModeConcurrency(3)).toBe(3);
    expect(parseAutoModeConcurrency("3")).toBe(3);
    expect(parseAutoModeConcurrency(JSON.stringify(3))).toBe(3);
  });

  it("clamps to the inclusive 0..10 range", () => {
    expect(parseAutoModeConcurrency(0)).toBe(0);
    expect(parseAutoModeConcurrency(10)).toBe(10);
    expect(parseAutoModeConcurrency(-4)).toBe(0);
    expect(parseAutoModeConcurrency(99)).toBe(10);
  });

  it("returns null for non-integers so the caller falls through", () => {
    expect(parseAutoModeConcurrency(undefined)).toBeNull();
    expect(parseAutoModeConcurrency(null)).toBeNull();
    expect(parseAutoModeConcurrency("")).toBeNull();
    expect(parseAutoModeConcurrency("abc")).toBeNull();
    expect(parseAutoModeConcurrency(1.5)).toBeNull();
  });
});

describe("parseAutoModeAgent", () => {
  it("accepts raw and JSON-encoded ids, trimming whitespace", () => {
    expect(parseAutoModeAgent("agent-1")).toBe("agent-1");
    expect(parseAutoModeAgent(JSON.stringify("agent-1"))).toBe("agent-1");
    expect(parseAutoModeAgent("  agent-1  ")).toBe("agent-1");
  });

  it("returns null for empty / non-string values", () => {
    expect(parseAutoModeAgent(undefined)).toBeNull();
    expect(parseAutoModeAgent(null)).toBeNull();
    expect(parseAutoModeAgent("")).toBeNull();
    expect(parseAutoModeAgent('""')).toBeNull();
    expect(parseAutoModeAgent(42)).toBeNull();
  });
});

describe("resolveAutoModeConfig (client-side, settings map)", () => {
  it("prefers the per-project key over the global one", () => {
    const config = resolveAutoModeConfig(
      {
        [AUTO_MODE_ENABLED_SETTING_KEY]: false,
        [autoModeEnabledSettingKey("p1")]: true,
        [AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY]: 5,
        [autoModeBuildConcurrencySettingKey("p1")]: 7,
      },
      "p1"
    );
    expect(config.enabled).toBe(true);
    expect(config.buildConcurrency).toBe(7);
  });

  it("falls through to the global key, then to the built-in default", () => {
    const config = resolveAutoModeConfig(
      { [AUTO_MODE_REVIEW_CONCURRENCY_SETTING_KEY]: 4 },
      "p1"
    );
    expect(config.enabled).toBe(false);
    expect(config.reviewConcurrency).toBe(4);
    expect(config.buildConcurrency).toBe(DEFAULT_AUTO_BUILD_CONCURRENCY);
    expect(config.buildAgent).toBeNull();
    expect(config.reviewAgent).toBeNull();
  });

  it("tolerates a missing settings map entirely", () => {
    expect(resolveAutoModeConfig(null, "p1")).toEqual({
      enabled: false,
      buildAgent: null,
      buildConcurrency: DEFAULT_AUTO_BUILD_CONCURRENCY,
      reviewAgent: null,
      reviewConcurrency: DEFAULT_AUTO_REVIEW_CONCURRENCY,
      smartDispatch: false,
    });
  });
});

describe("resolveAutoModeConfigForProject (server-side)", () => {
  it("returns the built-in defaults when nothing is configured", () => {
    expect(resolveAutoModeConfigForProject("p1")).toEqual({
      enabled: false,
      buildAgent: null,
      buildConcurrency: DEFAULT_AUTO_BUILD_CONCURRENCY,
      reviewAgent: null,
      reviewConcurrency: DEFAULT_AUTO_REVIEW_CONCURRENCY,
      // Informed selection is opt-in: an unattended mode must keep dispatching
      // the way it did yesterday until someone turns this on.
      smartDispatch: false,
    });
  });

  it("walks per-project → global → default one key at a time", () => {
    putSetting(AUTO_MODE_ENABLED_SETTING_KEY, false);
    putSetting(autoModeEnabledSettingKey("p1"), true);
    putSetting(AUTO_MODE_BUILD_CONCURRENCY_SETTING_KEY, 6);
    putSetting(autoModeReviewAgentSettingKey("p1"), "reviewer-agent");

    expect(resolveAutoModeConfigForProject("p1")).toEqual({
      enabled: true,
      buildAgent: null,
      buildConcurrency: 6,
      reviewAgent: "reviewer-agent",
      reviewConcurrency: DEFAULT_AUTO_REVIEW_CONCURRENCY,
      smartDispatch: false,
    });
  });

  it("resolves auto_mode_smart_dispatch per project → global → OFF", () => {
    expect(resolveAutoModeConfigForProject("p1").smartDispatch).toBe(false);

    putSetting(AUTO_MODE_SMART_DISPATCH_SETTING_KEY, true);
    expect(resolveAutoModeConfigForProject("p1").smartDispatch).toBe(true);

    // A project may opt out of a global ON, like every other flag here.
    putSetting(autoModeSmartDispatchSettingKey("p1"), false);
    expect(resolveAutoModeConfigForProject("p1").smartDispatch).toBe(false);
    expect(resolveAutoModeConfigForProject("p2").smartDispatch).toBe(true);
  });

  it("clamps stored concurrency values on read", () => {
    putSetting(autoModeBuildConcurrencySettingKey("p1"), 42);
    putSetting(autoModeReviewConcurrencySettingKey("p1"), -3);
    const config = resolveAutoModeConfigForProject("p1");
    expect(config.buildConcurrency).toBe(10);
    expect(config.reviewConcurrency).toBe(0);
  });

  it("re-reads on every call so a settings change needs no restart", () => {
    putSetting(autoModeEnabledSettingKey("p1"), true);
    expect(resolveAutoModeConfigForProject("p1").enabled).toBe(true);
    putSetting(autoModeEnabledSettingKey("p1"), false);
    expect(resolveAutoModeConfigForProject("p1").enabled).toBe(false);
  });

  it("scopes to the requested project", () => {
    putSetting(autoModeEnabledSettingKey("p1"), true);
    expect(resolveAutoModeConfigForProject("p2").enabled).toBe(false);
  });
});

describe("listAutoModeEnabledProjectIds", () => {
  function seedProjects(...ids: string[]): void {
    for (const id of ids) {
      db.insert(projects)
        .values({ id, name: id, gitRepoPath: `/repos/${id}` })
        .run();
    }
  }

  it("lists projects whose own key parses to true", () => {
    seedProjects("p1", "p2", "p3");
    putSetting(autoModeEnabledSettingKey("p1"), true);
    putSetting(autoModeEnabledSettingKey("p2"), false);
    expect(listAutoModeEnabledProjectIds()).toEqual(["p1"]);
  });

  it("is empty when nothing is configured", () => {
    seedProjects("p1", "p2");
    expect(listAutoModeEnabledProjectIds()).toEqual([]);
  });

  /**
   * Discovery MUST agree with resolveAutoModeConfigForProject, or the API
   * reports a project as enabled while the supervisor never sweeps it.
   */
  it("agrees with the resolver when the GLOBAL key is the one that enables", () => {
    seedProjects("p1", "p2", "p3");
    putSetting(AUTO_MODE_ENABLED_SETTING_KEY, true);
    putSetting(autoModeEnabledSettingKey("p3"), false);

    expect(resolveAutoModeConfigForProject("p1").enabled).toBe(true);
    expect(resolveAutoModeConfigForProject("p2").enabled).toBe(true);
    expect(resolveAutoModeConfigForProject("p3").enabled).toBe(false);

    expect(listAutoModeEnabledProjectIds().sort()).toEqual(["p1", "p2"]);
  });

  it("never disagrees with the resolver, whatever the key combination", () => {
    seedProjects("a", "b", "c", "d");
    putSetting(AUTO_MODE_ENABLED_SETTING_KEY, true);
    putSetting(autoModeEnabledSettingKey("b"), true);
    putSetting(autoModeEnabledSettingKey("c"), false);

    const discovered = new Set(listAutoModeEnabledProjectIds());
    for (const projectId of ["a", "b", "c", "d"]) {
      expect(discovered.has(projectId)).toBe(
        resolveAutoModeConfigForProject(projectId).enabled
      );
    }
  });
});
