import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbChain, state, mockListByProject, mockStatusForApi } = vi.hoisted(
  () => {
    const chain = {
      select: vi.fn(),
      from: vi.fn(),
      leftJoin: vi.fn(),
      where: vi.fn(),
      all: vi.fn(),
    };

    const sharedState = {
      rows: [] as Array<Record<string, unknown>>,
      registry: [] as Array<Record<string, unknown>>,
    };

    return {
      dbChain: chain,
      state: sharedState,
      mockListByProject: vi.fn(() => sharedState.registry),
      mockStatusForApi: vi.fn((status: string | null | undefined) => status ?? "queued"),
    };
  }
);

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
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
    prompt: "prompt",
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

vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: {
    listByProject: mockListByProject,
  },
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  getSessionStatusForApi: mockStatusForApi,
}));

describe("sessions/active route activity typing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows = [];
    state.registry = [];

    dbChain.select.mockReturnValue(dbChain);
    dbChain.from.mockReturnValue(dbChain);
    dbChain.leftJoin.mockReturnValue(dbChain);
    dbChain.where.mockReturnValue(dbChain);
    dbChain.all.mockImplementation(() => state.rows);
  });

  it("returns db sessions and registry chat activities with canonical status/mode fields", async () => {
    state.rows = [
      {
        id: "sess-1",
        epicId: "epic-1",
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "codex",
        prompt: null,
        startedAt: "2026-02-13T11:00:00.000Z",
        epicTitle: "Authentication",
        storyTitle: null,
      },
    ];
    state.registry = [
      {
        id: "chat-123",
        projectId: "proj-1",
        type: "chat",
        label: "Chat: Brainstorm",
        provider: "claude-code",
        startedAt: "2026-02-13T11:05:00.000Z",
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );
    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toHaveLength(2);

    const dbActivity = json.data.find((activity: { id: string }) => activity.id === "sess-1");
    expect(dbActivity).toMatchObject({
      id: "sess-1",
      epicId: "epic-1",
      userStoryId: null,
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

  it("classifies merge-resolution sessions as merge", async () => {
    state.rows = [
      {
        id: "sess-merge-1",
        epicId: "epic-1",
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "claude-code",
        prompt: "## Merge Conflict Resolution\nA `git merge main` was started.",
        startedAt: "2026-02-12T10:00:00.000Z",
        epicTitle: "Payments",
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );

    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "sess-merge-1",
      type: "merge",
      label: "Merging: Payments",
      epicId: "epic-1",
      userStoryId: null,
      status: "running",
      mode: "code",
    });
  });

  it("classifies review sessions as review even when mode is code", async () => {
    state.rows = [
      {
        id: "sess-review-1",
        epicId: "epic-2",
        userStoryId: "story-9",
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "claude-code",
        prompt:
          "You are performing a **security review** on the code changes for the ticket described above.",
        startedAt: "2026-02-12T10:05:00.000Z",
        epicTitle: "Auth",
        storyTitle: "Validate JWT audience",
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );

    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "sess-review-1",
      type: "review",
      label: "Reviewing: Validate JWT audience",
      epicId: "epic-2",
      userStoryId: "story-9",
      status: "running",
      mode: "code",
    });
  });

  it("keeps team sessions as build with Team Build label", async () => {
    state.rows = [
      {
        id: "sess-team-1",
        epicId: null,
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "team",
        provider: "claude-code",
        prompt: "team build prompt",
        startedAt: "2026-02-12T10:10:00.000Z",
        epicTitle: null,
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );

    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "sess-team-1",
      type: "build",
      label: "Team Build",
      epicId: null,
      userStoryId: null,
      status: "running",
      mode: "code",
    });
  });
});
