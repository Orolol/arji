import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
}));

vi.mock("@/lib/db/schema", () => ({
  agentSessions: {
    id: "id",
    projectId: "projectId",
    epicId: "epicId",
    userStoryId: "userStoryId",
    status: "status",
    mode: "mode",
    provider: "provider",
    startedAt: "startedAt",
    createdAt: "createdAt",
  },
}));

vi.mock("@/lib/db", () => {
  const chain: {
    select: ReturnType<typeof vi.fn>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  } = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    all: vi.fn(),
    insert: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.all.mockImplementation(() =>
    mockState.rows
      .filter((row) => row.status === "running")
      .map((row) => ({
        id: row.id as string,
        projectId: row.projectId as string,
        epicId: (row.epicId as string | null) ?? null,
        userStoryId: (row.userStoryId as string | null) ?? null,
        mode: (row.mode as string | null) ?? null,
        provider: (row.provider as string | null) ?? null,
        startedAt: (row.startedAt as string | null) ?? null,
      }))
  );

  chain.insert.mockReturnValue({
    values: vi.fn((payload: Record<string, unknown>) => ({
      run: vi.fn(() => {
        mockState.rows.push(payload);
      }),
    })),
  });

  const transaction = (fn: () => unknown) => () => fn();

  return {
    db: {
      ...chain,
      $client: { transaction },
    },
  };
});

describe("agent concurrency helper", () => {
  beforeEach(() => {
    mockState.rows = [];
  });

  it("creates standardized AGENT_ALREADY_RUNNING payloads", async () => {
    const {
      createAgentAlreadyRunningPayload,
      AGENT_ALREADY_RUNNING_CODE,
      isAgentAlreadyRunningPayload,
    } = await import("@/lib/agents/concurrency");

    const payload = createAgentAlreadyRunningPayload(
      { scope: "epic", projectId: "proj-1", epicId: "epic-1" },
      {
        id: "session-1",
        projectId: "proj-1",
        epicId: "epic-1",
        userStoryId: null,
        mode: "code",
        provider: "claude-code",
        startedAt: "2026-02-12T10:00:00.000Z",
      },
    );

    expect(payload.code).toBe(AGENT_ALREADY_RUNNING_CODE);
    expect(payload.data.activeSessionId).toBe("session-1");
    expect(payload.data.sessionUrl).toBe("/projects/proj-1/sessions/session-1");
    expect(isAgentAlreadyRunningPayload(payload)).toBe(true);
  });

  it("allows only one running session per target and releases lock on terminal status", async () => {
    const { insertRunningSessionWithGuard } = await import("@/lib/agents/concurrency");

    const target = {
      scope: "epic" as const,
      projectId: "proj-1",
      epicId: "epic-1",
    };

    const first = insertRunningSessionWithGuard(target, {
      id: "session-1",
      projectId: "proj-1",
      epicId: "epic-1",
      status: "running",
      mode: "code",
      createdAt: "2026-02-12T10:00:00.000Z",
    });
    expect(first.inserted).toBe(true);
    expect(mockState.rows).toHaveLength(1);

    const second = insertRunningSessionWithGuard(target, {
      id: "session-2",
      projectId: "proj-1",
      epicId: "epic-1",
      status: "running",
      mode: "code",
      createdAt: "2026-02-12T10:00:01.000Z",
    });
    expect(second.inserted).toBe(false);
    if (!second.inserted) {
      expect(second.conflict.id).toBe("session-1");
    }
    expect(mockState.rows).toHaveLength(1);

    mockState.rows[0].status = "completed";

    const third = insertRunningSessionWithGuard(target, {
      id: "session-3",
      projectId: "proj-1",
      epicId: "epic-1",
      status: "running",
      mode: "code",
      createdAt: "2026-02-12T10:00:02.000Z",
    });
    expect(third.inserted).toBe(true);
    expect(mockState.rows).toHaveLength(2);
  });
});
