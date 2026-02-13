import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbChain, listByProject, getSessionStatusForApi } = vi.hoisted(() => ({
  dbChain: {
    select: vi.fn(),
    from: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    all: vi.fn(),
  },
  listByProject: vi.fn(),
  getSessionStatusForApi: vi.fn((status: string) => status),
}));

vi.mock("@/lib/db", () => ({
  db: dbChain,
}));

vi.mock("@/lib/db/schema", () => ({
  agentSessions: {
    id: "id",
    epicId: "epicId",
    userStoryId: "userStoryId",
    status: "status",
    mode: "mode",
    orchestrationMode: "orchestrationMode",
    provider: "provider",
    startedAt: "startedAt",
    projectId: "projectId",
  },
  epics: {
    id: "epics.id",
    title: "epics.title",
  },
  userStories: {
    id: "user_stories.id",
    title: "user_stories.title",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
}));

vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: {
    listByProject,
  },
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  getSessionStatusForApi,
}));

describe("sessions active route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbChain.select.mockReturnValue(dbChain);
    dbChain.from.mockReturnValue(dbChain);
    dbChain.leftJoin.mockReturnValue(dbChain);
    dbChain.where.mockReturnValue(dbChain);
    getSessionStatusForApi.mockImplementation((status: string) => status);
  });

  it("returns db sessions and registry chat activities with canonical status/mode fields", async () => {
    dbChain.all.mockReturnValue([
      {
        id: "sess-1",
        epicId: "epic-1",
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "codex",
        startedAt: "2026-02-13T11:00:00.000Z",
        epicTitle: "Authentication",
        storyTitle: null,
      },
    ]);
    listByProject.mockReturnValue([
      {
        id: "chat-123",
        projectId: "proj-1",
        type: "chat",
        label: "Chat: Brainstorm",
        provider: "claude-code",
        startedAt: "2026-02-13T11:05:00.000Z",
      },
    ]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/active/route");
    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toHaveLength(2);

    const dbActivity = json.data.find((activity: { id: string }) => activity.id === "sess-1");
    expect(dbActivity).toMatchObject({
      id: "sess-1",
      type: "build",
      label: "Building: Authentication",
      status: "running",
      mode: "code",
      source: "db",
      provider: "codex",
      cancellable: true,
    });

    const registryActivity = json.data.find(
      (activity: { id: string }) => activity.id === "chat-123",
    );
    expect(registryActivity).toMatchObject({
      id: "chat-123",
      type: "chat",
      label: "Chat: Brainstorm",
      status: "running",
      mode: "plan",
      source: "registry",
      provider: "claude-code",
      cancellable: false,
    });
  });
});
