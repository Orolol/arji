import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbChain } = vi.hoisted(() => ({
  dbChain: {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    all: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({
  db: dbChain,
}));

vi.mock("@/lib/db/schema", () => ({
  agentSessions: {
    projectId: "projectId",
    createdAt: "createdAt",
  },
}));

vi.mock("@/lib/agent-sessions/backfill", () => ({
  runBackfillRecentSessionLastNonEmptyTextOnce: vi.fn(),
}));

describe("sessions list route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbChain.select.mockReturnValue(dbChain);
    dbChain.from.mockReturnValue(dbChain);
    dbChain.where.mockReturnValue(dbChain);
    dbChain.orderBy.mockReturnValue(dbChain);
  });

  it("returns lastNonEmptyText in list payload", async () => {
    dbChain.all.mockReturnValue([
      {
        id: "sess-1",
        status: "running",
        lastNonEmptyText: "Applying migrations",
        createdAt: "2026-02-12T00:00:00.000Z",
      },
    ]);

    const { GET } = await import("@/app/api/projects/[projectId]/sessions/route");
    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj-1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data[0].lastNonEmptyText).toBe("Applying migrations");
  });
});
