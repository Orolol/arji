import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { settings } = await import("@/lib/db/schema");
const {
  DEFAULT_VERIFY_COMMANDS,
  DEFAULT_VERIFY_TIMEOUT_MS,
  VERIFY_COMMANDS_SETTING_KEY,
  VERIFY_TIMEOUT_MS_SETTING_KEY,
  parseVerifyCommands,
  parseVerifyTimeoutMs,
  resolveVerifyConfig,
  verifyCommandsSettingKey,
  verifyTimeoutMsSettingKey,
} = await import("@/lib/verify/verify-constants");
const { resolveVerifyConfigForProject } = await import("@/lib/verify/config");

const TEST_COMMANDS = [
  { name: "test", command: "npm test" },
  { name: "lint", command: "npm run lint" },
];

/** Persist a value exactly as PATCH /api/settings does. */
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
});

describe("verify settings constants and parsers", () => {
  it("exposes client-safe global and per-project keys plus the defaults", () => {
    expect(VERIFY_COMMANDS_SETTING_KEY).toBe("verify_commands");
    expect(VERIFY_TIMEOUT_MS_SETTING_KEY).toBe("verify_timeout_ms");
    expect(verifyCommandsSettingKey("p1")).toBe("verify_commands:p1");
    expect(verifyTimeoutMsSettingKey("p1")).toBe("verify_timeout_ms:p1");
    expect(DEFAULT_VERIFY_COMMANDS).toEqual([]);
    expect(DEFAULT_VERIFY_TIMEOUT_MS).toBe(600_000);
  });

  it("parses command arrays in raw and PATCH-encoded forms", () => {
    expect(parseVerifyCommands(TEST_COMMANDS)).toEqual(TEST_COMMANDS);
    expect(parseVerifyCommands(JSON.stringify(TEST_COMMANDS))).toEqual(
      TEST_COMMANDS
    );
    expect(
      parseVerifyCommands(JSON.stringify(JSON.stringify(TEST_COMMANDS)))
    ).toEqual(TEST_COMMANDS);
  });

  it("treats an empty list as an explicit disable, not as missing", () => {
    expect(parseVerifyCommands([])).toEqual([]);
    expect(parseVerifyCommands(JSON.stringify([]))).toEqual([]);
  });

  it("rejects malformed command lists atomically", () => {
    expect(parseVerifyCommands(undefined)).toBeNull();
    expect(parseVerifyCommands("not json")).toBeNull();
    expect(parseVerifyCommands([{ name: "test", command: "" }])).toBeNull();
    expect(
      parseVerifyCommands([
        TEST_COMMANDS[0],
        { name: "missing-command" },
      ])
    ).toBeNull();
  });

  it("parses positive timeouts in raw and PATCH-encoded forms", () => {
    expect(parseVerifyTimeoutMs(120_000)).toBe(120_000);
    expect(parseVerifyTimeoutMs("120000")).toBe(120_000);
    expect(parseVerifyTimeoutMs(JSON.stringify("120000"))).toBe(120_000);
    expect(parseVerifyTimeoutMs(0)).toBeNull();
    expect(parseVerifyTimeoutMs(0.1)).toBeNull();
    expect(parseVerifyTimeoutMs(-1)).toBeNull();
    expect(parseVerifyTimeoutMs("forever")).toBeNull();
  });
});

describe("resolveVerifyConfig (client settings map)", () => {
  it("uses project, then global, then default independently per key", () => {
    expect(
      resolveVerifyConfig(
        {
          [VERIFY_COMMANDS_SETTING_KEY]: TEST_COMMANDS,
          [verifyCommandsSettingKey("p1")]: [
            { name: "build", command: "npm run build" },
          ],
          [VERIFY_TIMEOUT_MS_SETTING_KEY]: 90_000,
        },
        "p1"
      )
    ).toEqual({
      enabled: true,
      commands: [{ name: "build", command: "npm run build" }],
      timeoutMs: 90_000,
    });
  });

  it("is disabled when settings are absent", () => {
    expect(resolveVerifyConfig(undefined, "p1")).toEqual({
      enabled: false,
      commands: [],
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    });
  });
});

describe("resolveVerifyConfigForProject (SQLite settings)", () => {
  it("keeps verification disabled when no key exists", () => {
    expect(resolveVerifyConfigForProject("p1")).toEqual({
      enabled: false,
      commands: [],
      timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
    });
  });

  it("decodes values persisted by PATCH and falls back to global settings", () => {
    putSetting(VERIFY_COMMANDS_SETTING_KEY, TEST_COMMANDS);
    putSetting(VERIFY_TIMEOUT_MS_SETTING_KEY, 180_000);

    expect(resolveVerifyConfigForProject("p1")).toEqual({
      enabled: true,
      commands: TEST_COMMANDS,
      timeoutMs: 180_000,
    });
  });

  it("prefers every valid project setting over its global counterpart", () => {
    putSetting(VERIFY_COMMANDS_SETTING_KEY, TEST_COMMANDS);
    putSetting(VERIFY_TIMEOUT_MS_SETTING_KEY, 180_000);
    putSetting(verifyCommandsSettingKey("p1"), [
      { name: "typecheck", command: "npx tsc --noEmit" },
    ]);
    putSetting(verifyTimeoutMsSettingKey("p1"), 45_000);

    expect(resolveVerifyConfigForProject("p1")).toEqual({
      enabled: true,
      commands: [{ name: "typecheck", command: "npx tsc --noEmit" }],
      timeoutMs: 45_000,
    });
  });

  it("lets a project-level empty command list disable a global config", () => {
    putSetting(VERIFY_COMMANDS_SETTING_KEY, TEST_COMMANDS);
    putSetting(verifyCommandsSettingKey("p1"), []);

    expect(resolveVerifyConfigForProject("p1")).toMatchObject({
      enabled: false,
      commands: [],
    });
  });

  it("skips invalid project values and continues to global or default", () => {
    putSetting(VERIFY_COMMANDS_SETTING_KEY, TEST_COMMANDS);
    putSetting(VERIFY_TIMEOUT_MS_SETTING_KEY, 75_000);
    putSetting(verifyCommandsSettingKey("p1"), [
      { name: "broken", command: "" },
    ]);
    putSetting(verifyTimeoutMsSettingKey("p1"), -1);

    expect(resolveVerifyConfigForProject("p1")).toEqual({
      enabled: true,
      commands: TEST_COMMANDS,
      timeoutMs: 75_000,
    });
  });
});
