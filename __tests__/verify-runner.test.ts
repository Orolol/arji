import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import { epics, projects, verifyReports } from "@/lib/db/schema";
import type { ArijDatabase } from "@/lib/db";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
  default: { spawn: mockSpawn },
}));

import {
  VERIFY_KILL_GRACE_MS,
  VERIFY_OUTPUT_LIMIT_BYTES,
  runVerification,
} from "@/lib/verify/runner";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number;
  killed = false;
  kill = vi.fn((_signal?: NodeJS.Signals) => {
    this.killed = true;
    return true;
  });

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  close(code: number | null): void {
    this.emit("close", code);
  }
}

let testDb: ReturnType<typeof createTestDb>;

function input(overrides: Partial<Parameters<typeof runVerification>[0]> = {}) {
  return {
    projectId: "project-1",
    epicId: "epic-1",
    agentSessionId: null,
    worktreePath: "/tmp/arij-worktree-1",
    commands: [
      { name: "test", command: "npm test" },
      { name: "lint", command: "npm run lint" },
    ],
    timeoutMs: 1_000,
    database: testDb.db as ArijDatabase,
    ...overrides,
  };
}

async function nextTurn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  testDb = createTestDb();
  testDb.db.insert(projects).values({ id: "project-1", name: "Project" }).run();
  testDb.db
    .insert(epics)
    .values({ id: "epic-1", projectId: "project-1", title: "Epic" })
    .run();
  mockSpawn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  testDb.sqlite.close();
});

describe("runVerification", () => {
  it("runs configured commands sequentially in the epic worktree and persists a passing report", async () => {
    const testChild = new FakeChild(4101);
    const lintChild = new FakeChild(4102);
    mockSpawn
      .mockImplementationOnce(() => testChild)
      .mockImplementationOnce(() => lintChild);

    const pending = runVerification(input());

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "npm test",
      expect.objectContaining({
        cwd: "/tmp/arij-worktree-1",
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      })
    );

    testChild.stdout.write("tests passed\n");
    testChild.close(0);
    await nextTurn();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    lintChild.stderr.write("lint clean\n");
    lintChild.close(0);

    const report = await pending;
    expect(report.status).toBe("pass");
    expect(report.commands).toEqual([
      {
        name: "test",
        command: "npm test",
        exitCode: 0,
        durationMs: expect.any(Number),
        tail: "tests passed\n",
      },
      {
        name: "lint",
        command: "npm run lint",
        exitCode: 0,
        durationMs: expect.any(Number),
        tail: "lint clean\n",
      },
    ]);

    const persisted = testDb.db.select().from(verifyReports).get();
    expect(persisted).toMatchObject({
      id: report.id,
      projectId: "project-1",
      epicId: "epic-1",
      agentSessionId: null,
      status: "pass",
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
    });
    expect(JSON.parse(persisted!.commands)).toEqual(report.commands);
  });

  it("stops at the first failed command and captures both output streams", async () => {
    const child = new FakeChild(4201);
    mockSpawn.mockImplementationOnce(() => child);

    const pending = runVerification(input());
    child.stdout.write("stdout context\n");
    child.stderr.write("assertion failed\n");
    child.close(2);

    const report = await pending;
    expect(report.status).toBe("fail");
    expect(report.commands).toHaveLength(1);
    expect(report.commands[0]).toMatchObject({
      name: "test",
      command: "npm test",
      exitCode: 2,
    });
    expect(report.commands[0].tail).toContain("stdout context");
    expect(report.commands[0].tail).toContain("assertion failed");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("times out with SIGTERM then SIGKILL on the process group and marks the command failed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T10:00:00.000Z"));
    const child = new FakeChild(4301);
    mockSpawn.mockImplementationOnce(() => child);
    const killGroup = vi.spyOn(process, "kill").mockReturnValue(true);

    const pending = runVerification(input({ timeoutMs: 250 }));
    await vi.advanceTimersByTimeAsync(250);

    expect(killGroup).toHaveBeenCalledWith(-4301, "SIGTERM");
    expect(killGroup).not.toHaveBeenCalledWith(-4301, "SIGKILL");

    await vi.advanceTimersByTimeAsync(VERIFY_KILL_GRACE_MS);
    expect(killGroup).toHaveBeenCalledWith(-4301, "SIGKILL");
    child.close(null);

    const report = await pending;
    expect(report.status).toBe("fail");
    expect(report.commands).toEqual([
      expect.objectContaining({
        name: "test",
        exitCode: null,
        durationMs: 250 + VERIFY_KILL_GRACE_MS,
      }),
    ]);
    expect(report.commands[0].tail).toContain("timed out after 250 ms");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("bounds captured output by bytes and keeps its tail", async () => {
    const child = new FakeChild(4401);
    mockSpawn.mockImplementationOnce(() => child);
    const ending = "\nTHE-END-OF-OUTPUT\n";

    const pending = runVerification(
      input({ commands: [{ name: "test", command: "npm test" }] })
    );
    child.stdout.write(`BEGIN-OF-DISCARDED-OUTPUT\n${"x".repeat(90_000)}${ending}`);
    child.close(0);

    const report = await pending;
    const tail = report.commands[0].tail;
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(
      VERIFY_OUTPUT_LIMIT_BYTES
    );
    expect(tail).not.toContain("BEGIN-OF-DISCARDED-OUTPUT");
    expect(tail.endsWith(ending)).toBe(true);
  });
});
