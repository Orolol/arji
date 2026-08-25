import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  epics,
  projects,
  settings,
  ticketComments,
  agentSessions,
  userStories,
} from "@/lib/db/schema";
import {
  BUG_REGRESSION_CHECK_SETTING_KEY,
  BUG_REGRESSION_COMMAND_SETTING_KEY,
  DEFAULT_BUG_REGRESSION_COMMAND,
  DEFAULT_TEST_FILE_PATTERNS,
  TEST_FILE_PATTERNS_SETTING_KEY,
  parseBugRegressionCommand,
  parseBugRegressionSetting,
  parseTestFilePatterns,
  resolveBugRegressionCheckEnabled,
} from "@/lib/verify/regression-constants";
import {
  createVerifyGate,
  readRegressionConfig,
} from "@/lib/pipeline/verify";
import { REGRESSION_REPORT_MARKER } from "@/lib/verify/regression-report";
import * as regressionCheckModule from "@/lib/verify/regression-check";

/** Writes a settings row exactly the way PATCH /api/settings writes it. */
function putSetting(key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(value) },
    })
    .run();
}

describe("regression settings parsers (regression-constants.ts)", () => {
  describe("parseBugRegressionSetting", () => {
    it("handles boolean, stringified boolean, and JSON string", () => {
      expect(parseBugRegressionSetting(true)).toBe(true);
      expect(parseBugRegressionSetting(false)).toBe(false);
      expect(parseBugRegressionSetting("true")).toBe(true);
      expect(parseBugRegressionSetting("false")).toBe(false);
      expect(parseBugRegressionSetting(JSON.stringify(true))).toBe(true);
      expect(parseBugRegressionSetting(JSON.stringify(false))).toBe(false);
      expect(parseBugRegressionSetting(JSON.stringify("true"))).toBe(true);
      expect(parseBugRegressionSetting(JSON.stringify("false"))).toBe(false);
      expect(parseBugRegressionSetting(null)).toBeNull();
      expect(parseBugRegressionSetting("invalid")).toBeNull();
    });
  });

  describe("parseTestFilePatterns", () => {
    it("parses JSON arrays, JSON strings, raw strings, and string arrays", () => {
      // Direct array
      expect(parseTestFilePatterns(["**/*.test.ts", "**/*.spec.ts"])).toEqual([
        "**/*.test.ts",
        "**/*.spec.ts",
      ]);

      // JSON stringified array (as written by PATCH /api/settings)
      expect(
        parseTestFilePatterns(JSON.stringify(["**/*.test.ts", "**/*.spec.ts"]))
      ).toEqual(["**/*.test.ts", "**/*.spec.ts"]);

      // JSON stringified comma-separated string
      expect(
        parseTestFilePatterns(JSON.stringify("**/*.test.*, **/*.spec.*"))
      ).toEqual(["**/*.test.*", "**/*.spec.*"]);

      // Bare comma-separated string
      expect(parseTestFilePatterns("**/*.test.*, **/*.spec.*")).toEqual([
        "**/*.test.*",
        "**/*.spec.*",
      ]);

      // Bare newline-separated string
      expect(parseTestFilePatterns("**/*.test.*\n**/*.spec.*")).toEqual([
        "**/*.test.*",
        "**/*.spec.*",
      ]);

      // Empty / invalid fallbacks to null
      expect(parseTestFilePatterns("")).toBeNull();
      expect(parseTestFilePatterns("   ")).toBeNull();
      expect(parseTestFilePatterns(JSON.stringify([]))).toBeNull();
      expect(parseTestFilePatterns(null)).toBeNull();
      expect(parseTestFilePatterns(123)).toBeNull();
    });
  });

  describe("parseBugRegressionCommand", () => {
    it("parses raw templates and JSON-encoded templates with {files}", () => {
      // Raw string
      expect(parseBugRegressionCommand("npx vitest run {files}")).toBe(
        "npx vitest run {files}"
      );

      // JSON-encoded string (as written by PATCH /api/settings)
      expect(
        parseBugRegressionCommand(JSON.stringify("npm test -- {files}"))
      ).toBe("npm test -- {files}");

      // Missing {files} placeholder is rejected (returns null for fallback)
      expect(parseBugRegressionCommand("npm test")).toBeNull();
      expect(parseBugRegressionCommand(JSON.stringify("npm test"))).toBeNull();
      expect(parseBugRegressionCommand("")).toBeNull();
      expect(parseBugRegressionCommand(null)).toBeNull();
      expect(parseBugRegressionCommand(123)).toBeNull();
    });
  });

  describe("resolveBugRegressionCheckEnabled", () => {
    it("follows per-project -> global -> default false precedence", () => {
      expect(resolveBugRegressionCheckEnabled(null)).toBe(false);
      expect(resolveBugRegressionCheckEnabled({})).toBe(false);

      // Global setting
      expect(
        resolveBugRegressionCheckEnabled({
          [BUG_REGRESSION_CHECK_SETTING_KEY]: true,
        })
      ).toBe(true);

      // Per-project overrides global
      expect(
        resolveBugRegressionCheckEnabled(
          {
            [BUG_REGRESSION_CHECK_SETTING_KEY]: true,
            [`${BUG_REGRESSION_CHECK_SETTING_KEY}:proj-1`]: false,
          },
          "proj-1"
        )
      ).toBe(false);

      expect(
        resolveBugRegressionCheckEnabled(
          {
            [BUG_REGRESSION_CHECK_SETTING_KEY]: false,
            [`${BUG_REGRESSION_CHECK_SETTING_KEY}:proj-1`]: true,
          },
          "proj-1"
        )
      ).toBe(true);

      // Other project falls back to global
      expect(
        resolveBugRegressionCheckEnabled(
          {
            [BUG_REGRESSION_CHECK_SETTING_KEY]: true,
            [`${BUG_REGRESSION_CHECK_SETTING_KEY}:proj-1`]: false,
          },
          "proj-2"
        )
      ).toBe(true);
    });
  });
});

describe("readRegressionConfig (database settings round-trip)", () => {
  beforeEach(() => {
    db.delete(settings).run();
  });

  it("returns default values when no settings are present", () => {
    const config = readRegressionConfig("proj-1");
    expect(config.enabled).toBe(false);
    expect(config.patterns).toEqual(DEFAULT_TEST_FILE_PATTERNS);
    expect(config.commandTemplate).toBe(DEFAULT_BUG_REGRESSION_COMMAND);
  });

  it("decodes JSON-encoded global settings written by PATCH /api/settings", () => {
    putSetting(BUG_REGRESSION_CHECK_SETTING_KEY, true);
    putSetting(TEST_FILE_PATTERNS_SETTING_KEY, [
      "**/__tests__/**/*.test.ts",
      "**/*.spec.ts",
    ]);
    putSetting(BUG_REGRESSION_COMMAND_SETTING_KEY, "npm test -- {files}");

    const config = readRegressionConfig("proj-1");
    expect(config.enabled).toBe(true);
    expect(config.patterns).toEqual([
      "**/__tests__/**/*.test.ts",
      "**/*.spec.ts",
    ]);
    expect(config.commandTemplate).toBe("npm test -- {files}");
  });

  it("honors per-project settings over global settings", () => {
    // Global settings
    putSetting(BUG_REGRESSION_CHECK_SETTING_KEY, true);
    putSetting(TEST_FILE_PATTERNS_SETTING_KEY, ["**/*.test.js"]);
    putSetting(
      BUG_REGRESSION_COMMAND_SETTING_KEY,
      "npx jest --runInBand {files}"
    );

    // Project-specific overrides
    putSetting(`${BUG_REGRESSION_CHECK_SETTING_KEY}:proj-1`, false);
    putSetting(`${TEST_FILE_PATTERNS_SETTING_KEY}:proj-1`, [
      "src/**/*.test.ts",
    ]);
    putSetting(
      `${BUG_REGRESSION_COMMAND_SETTING_KEY}:proj-1`,
      "npx vitest run {files}"
    );

    const proj1Config = readRegressionConfig("proj-1");
    expect(proj1Config.enabled).toBe(false);
    expect(proj1Config.patterns).toEqual(["src/**/*.test.ts"]);
    expect(proj1Config.commandTemplate).toBe("npx vitest run {files}");

    // Project 2 sees global settings
    const proj2Config = readRegressionConfig("proj-2");
    expect(proj2Config.enabled).toBe(true);
    expect(proj2Config.patterns).toEqual(["**/*.test.js"]);
    expect(proj2Config.commandTemplate).toBe("npx jest --runInBand {files}");
  });

  it("skips invalid per-project values and falls through to global or default", () => {
    putSetting(
      BUG_REGRESSION_COMMAND_SETTING_KEY,
      "npm test -- {files}"
    );
    // Invalid command without {files}
    putSetting(`${BUG_REGRESSION_COMMAND_SETTING_KEY}:proj-1`, "invalid command");

    const config = readRegressionConfig("proj-1");
    expect(config.commandTemplate).toBe("npm test -- {files}");
  });
});

describe("createVerifyGate", () => {
  beforeEach(() => {
    db.delete(ticketComments).run();
    db.delete(agentSessions).run();
    db.delete(epics).run();
    db.delete(projects).run();
    db.delete(settings).run();
    vi.restoreAllMocks();
  });

  it("does not run for feature epics", async () => {
    db.insert(projects)
      .values({
        id: "proj-gate",
        name: "Test Project",
        gitRepoPath: "/tmp/repo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    db.insert(epics)
      .values({
        id: "epic-feat",
        projectId: "proj-gate",
        title: "Feature Epic",
        type: "feature",
        status: "in_progress",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    putSetting(BUG_REGRESSION_CHECK_SETTING_KEY, true);

    const gate = createVerifyGate({
      projectId: "proj-gate",
      epicId: "epic-feat",
      userStoryId: null,
      scope: "epic",
    });

    const outcome = await gate("sess-1");
    expect(outcome.ran).toBe(false);
    expect(outcome.passed).toBeNull();
  });

  it("does not run when bug_regression_check is OFF", async () => {
    db.insert(projects)
      .values({
        id: "proj-gate",
        name: "Test Project",
        gitRepoPath: "/tmp/repo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    db.insert(epics)
      .values({
        id: "epic-bug",
        projectId: "proj-gate",
        title: "Bug Epic",
        type: "bug",
        status: "in_progress",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    // Default OFF
    const gate = createVerifyGate({
      projectId: "proj-gate",
      epicId: "epic-bug",
      userStoryId: null,
      scope: "epic",
    });

    const outcome = await gate("sess-1");
    expect(outcome.ran).toBe(false);
  });

  it("runs regression check for bug epics, persists report comment with agentSessionId and correct scope", async () => {
    db.insert(projects)
      .values({
        id: "proj-gate",
        name: "Test Project",
        gitRepoPath: "/tmp/repo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    db.insert(epics)
      .values({
        id: "epic-bug",
        projectId: "proj-gate",
        title: "Bug Epic",
        type: "bug",
        status: "in_progress",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    db.insert(agentSessions)
      .values({
        id: "sess-code-1",
        projectId: "proj-gate",
        epicId: "epic-bug",
        agentType: "claude-code",
        status: "completed",
        worktreePath: "/tmp/worktree",
        branchName: "feature/epic-bug",
        createdAt: new Date().toISOString(),
      })
      .run();

    putSetting(BUG_REGRESSION_CHECK_SETTING_KEY, true);

    const spy = vi
      .spyOn(regressionCheckModule, "runRegressionCheck")
      .mockResolvedValueOnce({
        status: "passed",
        reason: null,
        testFiles: ["src/bug.test.ts"],
        detail: null,
      });

    const gate = createVerifyGate({
      projectId: "proj-gate",
      epicId: "epic-bug",
      userStoryId: null,
      scope: "epic",
    });

    const outcome = await gate("sess-code-1");
    expect(outcome.ran).toBe(true);
    expect(outcome.passed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // Verify persisted report comment
    const comments = db
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.epicId, "epic-bug"))
      .all();
    expect(comments).toHaveLength(1);
    expect(comments[0].epicId).toBe("epic-bug");
    expect(comments[0].userStoryId).toBeNull();
    expect(comments[0].agentSessionId).toBe("sess-code-1");
    expect(comments[0].author).toBe("agent");
    expect(comments[0].content).toContain(REGRESSION_REPORT_MARKER);
    expect(comments[0].content).toContain("PASSED");
  });

  it("persists story-scoped report comment to userStoryId only, not epicId", async () => {
    db.delete(userStories).run();

    db.insert(projects)
      .values({
        id: "proj-gate",
        name: "Test Project",
        gitRepoPath: "/tmp/repo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    db.insert(epics)
      .values({
        id: "epic-bug",
        projectId: "proj-gate",
        title: "Bug Epic",
        type: "bug",
        status: "in_progress",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();
    db.insert(userStories)
      .values({
        id: "story-1",
        epicId: "epic-bug",
        title: "Bug Story",
        createdAt: new Date().toISOString(),
      })
      .run();
    db.insert(agentSessions)
      .values({
        id: "sess-code-2",
        projectId: "proj-gate",
        epicId: "epic-bug",
        agentType: "claude-code",
        status: "completed",
        worktreePath: "/tmp/worktree",
        branchName: "feature/epic-bug",
        createdAt: new Date().toISOString(),
      })
      .run();

    putSetting(BUG_REGRESSION_CHECK_SETTING_KEY, true);

    vi.spyOn(regressionCheckModule, "runRegressionCheck").mockResolvedValueOnce({
      status: "failed",
      reason: "test_fails_on_branch",
      testFiles: ["src/bug.test.ts"],
      detail: "AssertionError: expected 1 to be 2",
    });
    const gate = createVerifyGate({
      projectId: "proj-gate",
      epicId: "epic-bug",
      userStoryId: "story-1",
      scope: "story",
    });

    const outcome = await gate("sess-code-2");
    expect(outcome.ran).toBe(true);
    expect(outcome.passed).toBe(false);

    const comments = db.select().from(ticketComments).all();
    expect(comments).toHaveLength(1);
    expect(comments[0].userStoryId).toBe("story-1");
    expect(comments[0].epicId).toBeNull();
    expect(comments[0].agentSessionId).toBe("sess-code-2");
  });
});
