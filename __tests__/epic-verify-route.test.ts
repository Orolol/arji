import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import {
  agentSessions,
  epics,
  projects,
  ticketActivityLog,
  verifyReports,
} from "@/lib/db/schema";
import {
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";
import { eventBus, type TicketEvent } from "@/lib/events/bus";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<
    typeof import("@/lib/db/test-utils").createTestDb
  > | null,
}));

const verifyMocks = vi.hoisted(() => ({
  resolveConfig: vi.fn(),
  runVerification: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.db;
  },
  get sqlite() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.sqlite;
  },
}));

vi.mock("@/lib/verify/config", () => ({
  resolveVerifyConfigForProject: verifyMocks.resolveConfig,
}));

vi.mock("@/lib/verify/runner", () => ({
  runVerification: verifyMocks.runVerification,
}));

import {
  GET,
  POST,
} from "@/app/api/projects/[projectId]/epics/[epicId]/verify/route";

const projectId = "project-verify-route";
const epicId = "epic-verify-route";
let scratchRoot: string;
let repoPath: string;
let worktreePath: string;

function callGet() {
  return GET(
    mockNextRequest({
      url: `http://localhost/api/projects/${projectId}/epics/${epicId}/verify`,
    }),
    mockRouteContext({ projectId, epicId })
  );
}

function callPost() {
  return POST(
    mockNextRequest({
      method: "POST",
      url: `http://localhost/api/projects/${projectId}/epics/${epicId}/verify`,
    }),
    mockRouteContext({ projectId, epicId })
  );
}

function seedSession(pathname: string, createdAt = "2026-08-25T12:00:00.000Z") {
  testDb.instance!.db
    .insert(agentSessions)
    .values({
      id: `session-${createdAt}`,
      projectId,
      epicId,
      status: "completed",
      worktreePath: pathname,
      createdAt,
    })
    .run();
}

beforeEach(() => {
  vi.clearAllMocks();
  testDb.instance = createTestDb();
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arij-verify-route-"));
  repoPath = path.join(scratchRoot, "projects", "repo");
  worktreePath = path.join(
    scratchRoot,
    "projects",
    ".arij-worktrees",
    "feature-epic-verify-route"
  );
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });

  testDb.instance.db
    .insert(projects)
    .values({ id: projectId, name: "Project", gitRepoPath: repoPath })
    .run();
  testDb.instance.db
    .insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Verify me",
      status: "review",
      branchName: "feature/epic-verify-route",
    })
    .run();

  verifyMocks.resolveConfig.mockReturnValue({
    enabled: true,
    commands: [{ name: "test", command: "npm test" }],
    timeoutMs: 600_000,
  });
  verifyMocks.runVerification.mockResolvedValue({
    id: "report-manual",
    projectId,
    epicId,
    agentSessionId: null,
    status: "pass",
    startedAt: "2026-08-25T12:01:00.000Z",
    finishedAt: "2026-08-25T12:01:01.000Z",
    commands: [
      {
        name: "test",
        command: "npm test",
        exitCode: 0,
        durationMs: 1_000,
        tail: "all green\n",
      },
    ],
  });
});

afterEach(() => {
  testDb.instance?.sqlite.close();
  testDb.instance = null;
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe("GET /api/projects/[projectId]/epics/[epicId]/verify", () => {
  it("returns the newest report with parsed command results", async () => {
    testDb.instance!.db.insert(verifyReports).values([
      {
        id: "older-report",
        projectId,
        epicId,
        status: "fail",
        startedAt: "2026-08-25T10:00:00.000Z",
        finishedAt: "2026-08-25T10:00:02.000Z",
        commands: JSON.stringify([
          {
            name: "test",
            command: "npm test",
            exitCode: 1,
            durationMs: 2_000,
            tail: "old failure",
          },
        ]),
      },
      {
        id: "newer-report",
        projectId,
        epicId,
        status: "pass",
        startedAt: "2026-08-25T11:00:00.000Z",
        finishedAt: "2026-08-25T11:00:01.000Z",
        commands: JSON.stringify([
          {
            name: "lint",
            command: "npm run lint",
            exitCode: 0,
            durationMs: 1_000,
            tail: "clean",
          },
        ]),
      },
    ]).run();

    const response = await callGet();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      id: "newer-report",
      status: "pass",
      commands: [
        {
          name: "lint",
          command: "npm run lint",
          exitCode: 0,
          tail: "clean",
        },
      ],
    });
  });

  it("returns null when the epic has never been verified", async () => {
    const response = await callGet();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: null });
  });

  it("returns null rather than a shorter report when a command row is corrupt", async () => {
    testDb.instance!.db
      .insert(verifyReports)
      .values({
        id: "corrupt-report",
        projectId,
        epicId,
        status: "fail",
        startedAt: "2026-08-25T10:00:00.000Z",
        finishedAt: "2026-08-25T10:00:02.000Z",
        commands: JSON.stringify([
          {
            name: "lint",
            command: "npm run lint",
            exitCode: 0,
            durationMs: 1_000,
            tail: "clean",
          },
          // The failing entry — the one that matters — lost its shape.
          { name: "test", command: "npm test" },
        ]),
      })
      .run();

    const response = await callGet();

    // Dropping the malformed entry would render this failing run as a
    // *shorter* report listing only the command that passed. This payload is
    // evidence: "unreadable" has to look like "never verified", not like a
    // clean bill of health.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: null });
  });
});

describe("POST /api/projects/[projectId]/epics/[epicId]/verify", () => {
  it("runs configured commands in the existing epic worktree and emits an SSE refresh", async () => {
    seedSession(worktreePath);
    const events: TicketEvent[] = [];
    const unsubscribe = eventBus.subscribe(projectId, (event) => events.push(event));

    const response = await callPost();
    const body = await response.json();
    unsubscribe();

    expect(response.status).toBe(200);
    expect(body.data.id).toBe("report-manual");
    expect(verifyMocks.runVerification).toHaveBeenCalledWith({
      projectId,
      epicId,
      agentSessionId: null,
      worktreePath,
      commands: [{ name: "test", command: "npm test" }],
      timeoutMs: 600_000,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "ticket:updated",
        projectId,
        epicId,
        data: {
          fields: {
            verifyReportId: "report-manual",
            verifyStatus: "pass",
          },
        },
      })
    );

    const activity = testDb.instance!.db.select().from(ticketActivityLog).all();
    expect(activity).toContainEqual(
      expect.objectContaining({
        projectId,
        epicId,
        actor: "system",
        fromStatus: "review",
        toStatus: "review",
      })
    );
  });

  it("returns a readable 409 and never runs when there is no recorded worktree", async () => {
    const response = await callPost();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/existing epic worktree/i);
    expect(verifyMocks.runVerification).not.toHaveBeenCalled();
  });

  it("refuses a recorded path outside .arij-worktrees instead of falling back to main", async () => {
    seedSession(repoPath);

    const response = await callPost();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/existing epic worktree/i);
    expect(verifyMocks.runVerification).not.toHaveBeenCalled();
  });

  it("refuses verification while an agent is active on the epic", async () => {
    seedSession(worktreePath);
    testDb.instance!.db
      .update(agentSessions)
      .set({ status: "running" })
      .run();

    const response = await callPost();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/while an agent is active/i);
    expect(verifyMocks.runVerification).not.toHaveBeenCalled();
  });

  it("returns a readable 409 pointing at Settings when verification is not configured", async () => {
    seedSession(worktreePath);
    verifyMocks.resolveConfig.mockReturnValue({
      enabled: false,
      commands: [],
      timeoutMs: 600_000,
    });

    const response = await callPost();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/not configured/i);
    expect(body.error).toMatch(/Settings/);
    expect(verifyMocks.runVerification).not.toHaveBeenCalled();
  });

  it("refuses a second manual verification in the same worktree", async () => {
    seedSession(worktreePath);
    let releaseFirst!: (report: unknown) => void;
    verifyMocks.runVerification.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        })
    );

    const firstRequest = callPost();
    await vi.waitFor(() => {
      expect(verifyMocks.runVerification).toHaveBeenCalledTimes(1);
    });

    const secondResponse = await callPost();
    expect(secondResponse.status).toBe(409);
    expect((await secondResponse.json()).error).toMatch(/already running/i);

    releaseFirst({
      id: "report-manual-concurrent",
      projectId,
      epicId,
      agentSessionId: null,
      status: "pass",
      startedAt: "2026-08-25T12:01:00.000Z",
      finishedAt: "2026-08-25T12:01:01.000Z",
      commands: [
        {
          name: "test",
          command: "npm test",
          exitCode: 0,
          durationMs: 1_000,
          tail: "all green\n",
        },
      ],
    });
    expect((await firstRequest).status).toBe(200);
  });
});
