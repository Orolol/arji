import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const { mockListByProject, mockStatusForApi, mockLastChunkAt } = vi.hoisted(
  () => ({
    mockListByProject: vi.fn(),
    mockStatusForApi: vi.fn(),
    mockLastChunkAt: vi.fn(),
  })
);

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock ignores
// column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/activity-registry", () => ({
  activityRegistry: {
    listByProject: mockListByProject,
  },
}));

vi.mock("@/lib/agent-sessions/lifecycle", () => ({
  getSessionStatusForApi: mockStatusForApi,
}));

// The watchdog helpers read chunk freshness through this module; mocking it
// lets tests steer lastActivityAt without a real chunk store.
vi.mock("@/lib/agent-sessions/chunks", () => ({
  lastSessionChunkAt: mockLastChunkAt,
}));

let registryRows: Array<Record<string, unknown>> = [];

describe("sessions/active route activity typing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    registryRows = [];
    mockListByProject.mockImplementation(() => registryRows);
    mockStatusForApi.mockImplementation(
      (status: string | null | undefined) => status ?? "queued",
    );
    mockLastChunkAt.mockReturnValue(null);
  });

  it("returns db sessions and registry chat activities with canonical status/mode fields", async () => {
    dbMockState.allRows = [
      {
        id: "sess-1",
        epicId: "epic-1",
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "codex",
        agentType: null,
        startedAt: "2026-02-13T11:00:00.000Z",
        epicTitle: "Authentication",
        storyTitle: null,
      },
    ];
    registryRows = [
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
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
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

  it("surfaces queued sessions with their status and an enqueue-time startedAt fallback", async () => {
    dbMockState.allRows = [
      {
        id: "sess-queued-1",
        epicId: "epic-9",
        userStoryId: null,
        status: "queued",
        mode: "code",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType: null,
        startedAt: null,
        createdAt: "2026-02-13T11:30:00.000Z",
        epicTitle: "Queued Epic",
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "sess-queued-1",
      type: "build",
      label: "Building: Queued Epic",
      status: "queued",
      startedAt: "2026-02-13T11:30:00.000Z",
      cancellable: true,
    });
  });

  /**
   * By `agentType`, not by the prompt. This case used to seed
   * `agentType: null` with the merge-resolution prompt, pinning a substring
   * test over the whole `prompt` column that has since been removed — it was
   * unreachable when right and reachable only when wrong (every
   * merge-resolution dispatch site writes `agent_type = "merge"`, and no live
   * row has a NULL `agent_type` at all). See
   * `sessions-active-route-projection.test.ts` for the measurement.
   */
  it("classifies merge-resolution sessions as merge", async () => {
    dbMockState.allRows = [
      {
        id: "sess-merge-1",
        epicId: "epic-1",
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType: "merge",
        startedAt: "2026-02-12T10:00:00.000Z",
        epicTitle: "Payments",
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );

    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));

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
    dbMockState.allRows = [
      {
        id: "sess-review-1",
        epicId: "epic-2",
        userStoryId: "story-9",
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "claude-code",
        // Same correction as the merge case above: the review header regex
        // over `prompt` is gone, and `review_*` is what real review sessions
        // carry. The point of the case — code mode must not demote a review
        // to a build — is unchanged.
        agentType: "review_security",
        startedAt: "2026-02-12T10:05:00.000Z",
        epicTitle: "Auth",
        storyTitle: "Validate JWT audience",
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );

    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));

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
    dbMockState.allRows = [
      {
        id: "sess-team-1",
        epicId: null,
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "team",
        provider: "claude-code",
        agentType: null,
        startedAt: "2026-02-12T10:10:00.000Z",
        epicTitle: null,
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );

    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));

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

  it("reports fresh chunk activity as lastActivityAt with stale false", async () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    mockLastChunkAt.mockReturnValue(recent);
    dbMockState.allRows = [
      {
        id: "sess-fresh",
        epicId: "epic-1",
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType: "build",
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        createdAt: null,
        epicTitle: "Fresh",
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
    const json = await response.json();

    expect(json.data[0]).toMatchObject({
      id: "sess-fresh",
      lastActivityAt: recent,
      stale: false,
    });
  });

  it("marks a running session stale past the watchdog threshold, falling back to startedAt when it has no chunks", async () => {
    const silentSince = new Date(Date.now() - 10 * 60_000).toISOString();
    dbMockState.allRows = [
      {
        id: "sess-stale",
        epicId: "epic-1",
        userStoryId: null,
        status: "running",
        mode: "code",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType: "build",
        startedAt: silentSince,
        createdAt: null,
        epicTitle: "Stale",
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
    const json = await response.json();

    expect(json.data[0]).toMatchObject({
      id: "sess-stale",
      lastActivityAt: silentSince,
      stale: true,
    });
  });

  it("never marks watchdog-exempt chat sessions stale", async () => {
    dbMockState.allRows = [
      {
        id: "sess-chat",
        epicId: null,
        userStoryId: null,
        status: "running",
        mode: "plan",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType: "chat",
        startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
        createdAt: null,
        epicTitle: null,
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
    const json = await response.json();

    expect(json.data[0]).toMatchObject({ id: "sess-chat", stale: false });
  });

  it("gives queued sessions enqueue activity while registry activity stays unknown", async () => {
    const queuedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    dbMockState.allRows = [
      {
        id: "sess-queued-activity",
        epicId: "epic-9",
        userStoryId: null,
        status: "queued",
        mode: "code",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType: "build",
        startedAt: null,
        createdAt: queuedAt,
        epicTitle: "Queued",
        storyTitle: null,
      },
    ];
    registryRows = [
      {
        id: "chat-reg",
        projectId: "proj-1",
        type: "chat",
        label: "Chat: Ideas",
        provider: "claude-code",
        startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );
    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
    const json = await response.json();

    const queued = json.data.find((a: { id: string }) => a.id === "sess-queued-activity");
    expect(queued).toMatchObject({
      lastActivityAt: queuedAt,
      stale: false,
    });
    expect(mockLastChunkAt).not.toHaveBeenCalledWith("sess-queued-activity");

    const registry = json.data.find((a: { id: string }) => a.id === "chat-reg");
    expect(registry).toMatchObject({ lastActivityAt: null, stale: false });
  });

  /**
   * Both memory writers run in PLAN mode with no epicId, so the route's mode
   * heuristic would file them as reviews and the monitor would say "Reviewing"
   * while an agent rewrites the project memory. These cases pin the type and
   * the exact labels so a regression back to "Reviewing" cannot pass.
   */
  it.each([
    ["dreaming", "Dreaming: rewriting project memory"],
    ["memory_distill", "Distilling project memory"],
  ])("classifies %s sessions as memory work", async (agentType, label) => {
    dbMockState.allRows = [
      {
        id: `sess-${agentType}`,
        epicId: null,
        userStoryId: null,
        status: "running",
        mode: "plan",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType,
        startedAt: "2026-02-12T10:12:00.000Z",
        epicTitle: null,
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );

    const response = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: `sess-${agentType}`,
      type: "memory",
      label,
      mode: "plan",
    });
  });

  it("classifies the ticket-less plan-mode failure digest as QA work", async () => {
    dbMockState.allRows = [
      {
        id: "sess-failure-digest",
        epicId: null,
        userStoryId: null,
        status: "running",
        mode: "plan",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType: "failure_digest",
        startedAt: "2026-02-12T10:12:00.000Z",
        epicTitle: null,
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );
    const response = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: "proj-1" }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "sess-failure-digest",
      type: "qa",
      label: "Analyzing recurring failures",
      mode: "plan",
    });
  });

  it("classifies plan-mode grading sessions explicitly", async () => {
    dbMockState.allRows = [
      {
        id: "sess-grading",
        epicId: "epic-grade",
        userStoryId: null,
        status: "running",
        mode: "plan",
        orchestrationMode: "solo",
        provider: "codex",
        agentType: "grading",
        startedAt: "2026-02-12T10:12:00.000Z",
        epicTitle: "Structured outcomes",
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );
    const response = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "sess-grading",
      type: "grading",
      label: "Grading: Structured outcomes",
      mode: "plan",
    });
  });

  it("classifies release note sessions as release", async () => {
    dbMockState.allRows = [
      {
        id: "sess-release-1",
        epicId: null,
        userStoryId: null,
        status: "running",
        mode: "plan",
        orchestrationMode: "solo",
        provider: "claude-code",
        agentType: "release_notes",
        startedAt: "2026-02-12T10:12:00.000Z",
        epicTitle: null,
        storyTitle: null,
      },
    ];

    const { GET } = await import(
      "@/app/api/projects/[projectId]/sessions/active/route"
    );

    const response = await GET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "sess-release-1",
      type: "release",
      label: "Generating release notes",
      mode: "plan",
    });
  });
});
