/**
 * The device-flow credential write, against the REAL schema.
 *
 * Every other device-flow test mocks `@/lib/db`, which is the right call for
 * what they assert — routing, guards, status codes. But it leaves the write
 * itself unproven: the poll route's `INSERT ... ON CONFLICT(key) DO UPDATE`
 * and the transaction wrapped around it have, until this file, only ever run
 * against a chain mock that records calls and agrees with whatever it is
 * handed. A wrong conflict target, a `settings.key` that turned out not to be
 * unique, or a transaction that does not actually roll back would pass there
 * unnoticed.
 *
 * So this file mocks GitHub and nothing else. `vitest.setup.ts` points
 * `ARIJ_DB_PATH` at a private temp file per test file and `lib/db` runs the
 * full migration chain on first access, so the table under test is the one the
 * product ships.
 *
 * The property that matters most is atomicity, and it is a claim the route
 * makes in prose: a token without its meta reads in Settings as a hand-pasted
 * PAT, and meta without its token claims a connection that cannot make an API
 * call. Neither half is usable alone. `settles nothing when the second write
 * fails` is that claim tested against a real ROLLBACK rather than a mock that
 * throws before any statement runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockJsonRequest, mockNextRequest } from "@/__tests__/helpers/db-mock";
import { sqlite } from "@/lib/db";
import { GITHUB_PAT_SETTING_KEY } from "@/lib/github/client";
import { GITHUB_OAUTH_META_SETTING_KEY } from "@/lib/github/oauth-meta";
import { _resetDeviceFlowStoreForTests } from "@/lib/github/device-flow-store";
import type { DeviceFlowStart } from "@/lib/github/device-flow";

const mockStartDeviceFlow = vi.hoisted(() => vi.fn());
const mockPollDeviceFlow = vi.hoisted(() => vi.fn());
const mockValidateGitHubToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/github/device-flow", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github/device-flow")>(
    "@/lib/github/device-flow"
  );
  return {
    ...actual,
    startDeviceFlow: mockStartDeviceFlow,
    pollDeviceFlow: mockPollDeviceFlow,
  };
});

vi.mock("@/lib/github/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github/client")>(
    "@/lib/github/client"
  );
  return { ...actual, validateGitHubToken: mockValidateGitHubToken };
});

const DEVICE_CODE = "dc_secret_device_code_value";
const ACCESS_TOKEN = "gho_live_access_token_value";
const MANUAL_PAT = "ghp_pasted_by_hand_value";

/** Fails any write of the meta key, so the SECOND statement in the
 *  transaction aborts while the first has already been applied. Both events
 *  are covered because `ON CONFLICT DO UPDATE` fires INSERT or UPDATE triggers
 *  depending on whether the row was already there. */
const FAIL_META_TRIGGERS = `
  CREATE TRIGGER fail_meta_insert BEFORE INSERT ON settings
  WHEN NEW.key = '${GITHUB_OAUTH_META_SETTING_KEY}'
  BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
  CREATE TRIGGER fail_meta_update BEFORE UPDATE ON settings
  WHEN NEW.key = '${GITHUB_OAUTH_META_SETTING_KEY}'
  BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
`;

function githubStart(overrides: Partial<DeviceFlowStart> = {}): DeviceFlowStart {
  return {
    deviceCode: DEVICE_CODE,
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresIn: 900,
    interval: 5,
    ...overrides,
  };
}

async function startFlow(): Promise<string> {
  const { POST } = await import("@/app/api/auth/github/device/start/route");
  const res = await POST(mockNextRequest({ method: "POST" }));
  return (await res.json()).data.handle;
}

async function poll(handle: string) {
  const { POST } = await import("@/app/api/auth/github/device/poll/route");
  const res = await POST(mockJsonRequest({ handle }));
  return { res, json: await res.json() };
}

/** Read a settings row straight out of SQLite, bypassing every abstraction. */
function readSetting(key: string): string | undefined {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as string) : undefined;
}

function countRows(key: string): number {
  return (
    sqlite
      .prepare("SELECT COUNT(*) AS n FROM settings WHERE key = ?")
      .get(key) as { n: number }
  ).n;
}

function seedSetting(key: string, value: unknown): void {
  sqlite
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
    .run(key, JSON.stringify(value));
}

function authorized() {
  return { state: "success", accessToken: ACCESS_TOKEN, scopes: ["repo", "read:user"] };
}

beforeEach(() => {
  sqlite.exec("DROP TRIGGER IF EXISTS fail_meta_insert");
  sqlite.exec("DROP TRIGGER IF EXISTS fail_meta_update");
  sqlite.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(
    GITHUB_PAT_SETTING_KEY,
    GITHUB_OAUTH_META_SETTING_KEY
  );
  mockStartDeviceFlow.mockReset();
  mockPollDeviceFlow.mockReset();
  mockValidateGitHubToken.mockReset();
  _resetDeviceFlowStoreForTests();
  mockStartDeviceFlow.mockResolvedValue(githubStart());
  mockValidateGitHubToken.mockResolvedValue({ valid: true, login: "octocat" });
});

describe("the credential write against the real settings table", () => {
  it("lands both halves under the keys the rest of the app already reads", async () => {
    const handle = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce(authorized());

    const { res } = await poll(handle);
    expect(res.status).toBe(200);

    // The token goes to the EXISTING key, unchanged in shape — the whole
    // reason clone/PR/issue/release code needed no edit for this epic.
    expect(readSetting(GITHUB_PAT_SETTING_KEY)).toBe(ACCESS_TOKEN);

    const meta = readSetting(GITHUB_OAUTH_META_SETTING_KEY) as unknown as {
      login: string;
      scopes: string[];
      tokenSource: string;
      obtainedAt: string;
    };
    expect(meta.login).toBe("octocat");
    expect(meta.scopes).toEqual(["repo", "read:user"]);
    expect(meta.tokenSource).toBe("oauth_device");
    expect(Number.isNaN(Date.parse(meta.obtainedAt))).toBe(false);
  });

  it("replaces a previous connection instead of duplicating it", async () => {
    // The upsert's UPDATE branch, which only a real unique key can take: a
    // second sign-in must leave one row per key, not two.
    seedSetting(GITHUB_PAT_SETTING_KEY, MANUAL_PAT);
    seedSetting(GITHUB_OAUTH_META_SETTING_KEY, {
      login: "previous-user",
      scopes: ["repo"],
      obtainedAt: "2020-01-01T00:00:00.000Z",
      tokenSource: "manual",
    });

    const handle = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce(authorized());
    expect((await poll(handle)).res.status).toBe(200);

    expect(countRows(GITHUB_PAT_SETTING_KEY)).toBe(1);
    expect(countRows(GITHUB_OAUTH_META_SETTING_KEY)).toBe(1);
    expect(readSetting(GITHUB_PAT_SETTING_KEY)).toBe(ACCESS_TOKEN);
    expect(
      (readSetting(GITHUB_OAUTH_META_SETTING_KEY) as unknown as { login: string }).login
    ).toBe("octocat");
  });

  it("writes neither half when the second statement fails", async () => {
    // A real ROLLBACK, not a mock that throws before any statement runs: the
    // token write is applied first and must be undone by the meta write's
    // abort. Half a connection is worse than none — a bare `github_pat` reads
    // in Settings as a PAT the user pasted by hand.
    const handle = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce(authorized());
    sqlite.exec(FAIL_META_TRIGGERS);

    const { res, json } = await poll(handle);

    expect(res.status).toBe(500);
    expect(json.code).toBe("DEVICE_FLOW_PERSIST_FAILED");
    expect(readSetting(GITHUB_PAT_SETTING_KEY)).toBeUndefined();
    expect(readSetting(GITHUB_OAUTH_META_SETTING_KEY)).toBeUndefined();
  });

  it("leaves a hand-pasted PAT intact when the write it would replace fails", async () => {
    // The same rollback seen from the user's side. They had a working manual
    // token; an OAuth sign-in that cannot complete must not cost them it.
    seedSetting(GITHUB_PAT_SETTING_KEY, MANUAL_PAT);

    const handle = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce(authorized());
    sqlite.exec(FAIL_META_TRIGGERS);

    expect((await poll(handle)).res.status).toBe(500);

    expect(readSetting(GITHUB_PAT_SETTING_KEY)).toBe(MANUAL_PAT);
    expect(readSetting(GITHUB_OAUTH_META_SETTING_KEY)).toBeUndefined();
  });

  it("never echoes the token when a REAL sqlite error is what failed", async () => {
    // The sibling test in the lifecycle file synthesises the error object.
    // Here the message is SQLite's own, so this also pins that whatever
    // better-sqlite3 chooses to put in it stays out of the response.
    const handle = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce(authorized());
    sqlite.exec(FAIL_META_TRIGGERS);

    const { json } = await poll(handle);

    expect(JSON.stringify(json)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(json)).not.toContain(DEVICE_CODE);
    expect(json.error).not.toContain("disk I/O error");
  });

  it("settles the spent authorization, so the handle stops resolving", async () => {
    const handle = await startFlow();
    mockPollDeviceFlow.mockResolvedValueOnce(authorized());
    sqlite.exec(FAIL_META_TRIGGERS);

    expect((await poll(handle)).res.status).toBe(500);

    const again = await poll(handle);
    expect(again.res.status).toBe(404);
    expect(again.json.code).toBe("DEVICE_FLOW_NOT_FOUND");
    // The device code was exchanged once and never retried.
    expect(mockPollDeviceFlow).toHaveBeenCalledTimes(1);
  });
});
