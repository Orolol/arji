import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, mockValidateSameProject, mockValidateDagIntegrity } = vi.hoisted(() => ({
  state: {
    allQueue: [] as unknown[],
    insertCalls: [] as Array<{ table: unknown; payload: unknown }>,
  },
  mockValidateSameProject: vi.fn(),
  mockValidateDagIntegrity: vi.fn(),
}));

const mockSchema = vi.hoisted(() => ({
  ticketDependencies: {
    __name: "ticketDependencies",
    id: "id",
    ticketId: "ticketId",
    dependsOnTicketId: "dependsOnTicketId",
    projectId: "projectId",
  },
}));

const mockIdState = vi.hoisted(() => ({ value: 1 }));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    all: vi.fn(),
    insert: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.all.mockImplementation(() => state.allQueue.shift() ?? []);
  chain.insert.mockImplementation((table: unknown) => ({
    values: vi.fn((payload: unknown) => {
      state.insertCalls.push({ table, payload });
      return { run: vi.fn() };
    }),
  }));

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  ticketDependencies: mockSchema.ticketDependencies,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => {
    const id = `dep-${mockIdState.value}`;
    mockIdState.value += 1;
    return id;
  }),
}));

vi.mock("@/lib/dependencies/validation", () => ({
  validateSameProject: mockValidateSameProject,
  validateDagIntegrity: mockValidateDagIntegrity,
}));

describe("dependencies CRUD batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.allQueue = [];
    state.insertCalls = [];
    mockIdState.value = 1;
  });

  it("inserts only missing edges in a single batch insert", async () => {
    state.allQueue = [
      [{ ticketId: "epic-1", dependsOnTicketId: "epic-2" }],
    ];

    const { createDependencies } = await import("@/lib/dependencies/crud");
    const created = createDependencies("proj-1", [
      { ticketId: "epic-1", dependsOnTicketId: "epic-2" },
      { ticketId: "epic-3", dependsOnTicketId: "epic-4" },
    ]);

    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(
      expect.objectContaining({
        id: "dep-1",
        ticketId: "epic-3",
        dependsOnTicketId: "epic-4",
        projectId: "proj-1",
      }),
    );
    expect(state.insertCalls).toHaveLength(1);
    expect((state.insertCalls[0].payload as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(mockValidateSameProject).toHaveBeenCalledWith("proj-1", [
      { ticketId: "epic-1", dependsOnTicketId: "epic-2" },
      { ticketId: "epic-3", dependsOnTicketId: "epic-4" },
    ]);
    expect(mockValidateDagIntegrity).toHaveBeenCalledWith("proj-1", [
      { ticketId: "epic-1", dependsOnTicketId: "epic-2" },
      { ticketId: "epic-3", dependsOnTicketId: "epic-4" },
    ]);
  });

  it("drops self-dependencies and duplicate edges before insert", async () => {
    state.allQueue = [[]];

    const { createDependencies } = await import("@/lib/dependencies/crud");
    const created = createDependencies("proj-1", [
      { ticketId: "epic-1", dependsOnTicketId: "epic-1" },
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
    ]);

    expect(created).toHaveLength(1);
    expect(state.insertCalls).toHaveLength(1);
    expect((state.insertCalls[0].payload as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(mockValidateSameProject).toHaveBeenCalledWith("proj-1", [
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
    ]);
  });

  it("skips insert when all candidate edges already exist", async () => {
    state.allQueue = [[{ ticketId: "epic-2", dependsOnTicketId: "epic-3" }]];

    const { createDependencies } = await import("@/lib/dependencies/crud");
    const created = createDependencies("proj-1", [
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
    ]);

    expect(created).toEqual([]);
    expect(state.insertCalls).toHaveLength(0);
  });
});
