import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  updateSetCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    get: vi.fn(() => mockDbState.getQueue.shift() ?? null),
    update: vi.fn().mockReturnValue({
      set: vi.fn((payload: Record<string, unknown>) => {
        mockDbState.updateSetCalls.push(payload);
        return {
          where: vi.fn().mockReturnValue({ run: vi.fn() }),
        };
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
  };

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  projects: {
    id: "id",
  },
  epics: {},
  userStories: {},
  documents: {},
  chatMessages: {},
  agentSessions: {},
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: vi.fn(),
}));

describe("PATCH /api/projects/[projectId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
    mockDbState.updateSetCalls = [];
  });

  it("stores githubOwnerRepo when provided", async () => {
    mockDbState.getQueue = [
      { id: "proj-1", name: "Arij" },
      { id: "proj-1", name: "Arij", githubOwnerRepo: "octocat/hello-world" },
    ];

    const { PATCH } = await import("@/app/api/projects/[projectId]/route");
    const res = await PATCH(
      {
        json: () => Promise.resolve({ githubOwnerRepo: "octocat/hello-world" }),
      } as unknown as import("next/server").NextRequest,
      { params: Promise.resolve({ projectId: "proj-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockDbState.updateSetCalls[0]).toEqual(
      expect.objectContaining({
        githubOwnerRepo: "octocat/hello-world",
      })
    );
    expect(json.data.githubOwnerRepo).toBe("octocat/hello-world");
  });
});
