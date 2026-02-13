import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbChain, runCutoverMigrationOnce } = vi.hoisted(() => ({
  dbChain: {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    all: vi.fn(),
    insert: vi.fn(),
    values: vi.fn(),
    run: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
  },
  runCutoverMigrationOnce: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbChain,
}));

vi.mock("@/lib/db/schema", () => ({
  chatConversations: {
    id: "id",
    projectId: "projectId",
    createdAt: "createdAt",
  },
  chatMessages: {
    projectId: "projectId",
    conversationId: "conversationId",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
  and: vi.fn((...items) => ({ and: items })),
  isNull: vi.fn((value) => ({ isNull: value })),
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "conv-created"),
}));

vi.mock("@/lib/agent-config/providers", () => ({
  resolveAgentProvider: vi.fn(async () => "claude-code"),
}));

vi.mock("@/lib/chat/unified-cutover-migration", () => ({
  runUnifiedChatCutoverMigrationOnce: runCutoverMigrationOnce,
}));

describe("conversations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbChain.select.mockReturnValue(dbChain);
    dbChain.from.mockReturnValue(dbChain);
    dbChain.where.mockReturnValue(dbChain);
    dbChain.orderBy.mockReturnValue(dbChain);
    dbChain.insert.mockReturnValue(dbChain);
    dbChain.values.mockReturnValue(dbChain);
    dbChain.update.mockReturnValue(dbChain);
    dbChain.set.mockReturnValue(dbChain);
  });

  it("runs cutover migration and normalizes legacy type/status order", async () => {
    dbChain.all.mockReturnValue([
      {
        id: "conv-newer",
        projectId: "proj-1",
        type: "brainstorm",
        label: "Brainstorm",
        status: "mystery",
        epicId: null,
        provider: "claude-code",
        createdAt: "2026-02-12T12:00:00.000Z",
      },
      {
        id: "conv-older",
        projectId: "proj-1",
        type: "epic",
        label: "Legacy Epic",
        status: "generating",
        epicId: null,
        provider: "claude-code",
        createdAt: "2026-02-12T11:00:00.000Z",
      },
    ]);

    const { GET } = await import("@/app/api/projects/[projectId]/conversations/route");

    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });
    const json = await response.json();

    expect(runCutoverMigrationOnce).toHaveBeenCalledWith("proj-1");
    expect(json.data).toHaveLength(2);
    expect(json.data[0]).toMatchObject({
      id: "conv-older",
      type: "epic_creation",
      status: "generating",
    });
    expect(json.data[1]).toMatchObject({
      id: "conv-newer",
      status: "active",
    });
  });
});
