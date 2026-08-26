import { beforeEach, describe, expect, it, vi } from "vitest";
import { dbMockState, resetDbMockState } from "@/__tests__/helpers/db-mock";

const {
  mockValidateSameProject,
  mockValidateDagIntegrity,
  mockEmitDependenciesChanged,
} = vi.hoisted(() => ({
  mockValidateSameProject: vi.fn(),
  mockValidateDagIntegrity: vi.fn(),
  mockEmitDependenciesChanged: vi.fn(),
}));

const mockIdState = vi.hoisted(() => ({ value: 1 }));

// Real drizzle-orm + real @/lib/db/schema: both are side-effect-free pure
// builders, and the chain mock ignores their output. No fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

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

vi.mock("@/lib/events/emit", () => ({
  emitTicketDependenciesChanged: mockEmitDependenciesChanged,
}));

/** Every ticket id announced across all emits, order-independent. */
function announcedTicketIds(): string[] {
  return mockEmitDependenciesChanged.mock.calls
    .flatMap((call) => [...(call[1] as Iterable<string>)])
    .sort();
}

describe("dependencies CRUD batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockIdState.value = 1;
  });

  it("inserts only missing edges in a single batch insert", async () => {
    dbMockState.allQueue = [
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
    expect(dbMockState.insertCalls).toHaveLength(1);
    expect((dbMockState.insertCalls[0] as Array<Record<string, unknown>>)).toHaveLength(1);
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
    dbMockState.allQueue = [[]];

    const { createDependencies } = await import("@/lib/dependencies/crud");
    const created = createDependencies("proj-1", [
      { ticketId: "epic-1", dependsOnTicketId: "epic-1" },
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
    ]);

    expect(created).toHaveLength(1);
    expect(dbMockState.insertCalls).toHaveLength(1);
    expect((dbMockState.insertCalls[0] as Array<Record<string, unknown>>)).toHaveLength(1);
    expect(mockValidateSameProject).toHaveBeenCalledWith("proj-1", [
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
    ]);
  });

  it("skips insert when all candidate edges already exist", async () => {
    dbMockState.allQueue = [[{ ticketId: "epic-2", dependsOnTicketId: "epic-3" }]];

    const { createDependencies } = await import("@/lib/dependencies/crud");
    const created = createDependencies("proj-1", [
      { ticketId: "epic-2", dependsOnTicketId: "epic-3" },
    ]);

    expect(created).toEqual([]);
    expect(dbMockState.insertCalls).toHaveLength(0);
    // Nothing changed, so nothing to invalidate.
    expect(mockEmitDependenciesChanged).not.toHaveBeenCalled();
  });
});

describe("dependency change events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    mockIdState.value = 1;
  });

  it("announces both endpoints of every created edge", async () => {
    // The board derives blocked state and hover adjacency from the edge list,
    // so a new edge changes the dependent AND the prerequisite.
    dbMockState.allQueue = [[]];

    const { createDependencies } = await import("@/lib/dependencies/crud");
    createDependencies("proj-1", [
      { ticketId: "epic-1", dependsOnTicketId: "epic-2" },
    ]);

    expect(mockEmitDependenciesChanged).toHaveBeenCalledTimes(1);
    expect(mockEmitDependenciesChanged.mock.calls[0][0]).toBe("proj-1");
    expect(announcedTicketIds()).toEqual(["epic-1", "epic-2"]);
  });

  it("rolls the delete back when the replacement is rejected", async () => {
    // Validation runs inside the insert, after the delete. Un-transacted, a
    // rejected edit returns 422 while silently destroying the ticket's
    // existing edges — and no event fires on the throw path, so the board goes
    // on showing dependencies that no longer exist.
    dbMockState.allQueue = [
      [{ ticketId: "epic-1", dependsOnTicketId: "epic-2" }],
      [],
    ];
    mockValidateDagIntegrity.mockImplementationOnce(() => {
      throw new Error("Dependency cycle detected");
    });

    const { setTicketDependencies } = await import("@/lib/dependencies/crud");
    expect(() =>
      setTicketDependencies("proj-1", "epic-1", ["epic-3"])
    ).toThrow(/cycle/i);

    // The delete and the insert went through one transaction call, so the
    // throw unwinds both rather than leaving the ticket edge-less.
    const { db } = await import("@/lib/db");
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // Nothing durable changed, so nothing was announced.
    expect(mockEmitDependenciesChanged).not.toHaveBeenCalled();
  });

  it("announces the ex-prerequisite when a dependency is removed", async () => {
    // setTicketDependencies replaces the whole set, so clearing it is how the
    // UI deletes an edge. epic-2 loses a dependent and must be told.
    dbMockState.allQueue = [[{ ticketId: "epic-1", dependsOnTicketId: "epic-2" }]];

    const { setTicketDependencies } = await import("@/lib/dependencies/crud");
    const created = setTicketDependencies("proj-1", "epic-1", []);

    expect(created).toEqual([]);
    expect(announcedTicketIds()).toEqual(["epic-1", "epic-2"]);
  });

  it("announces the old and the new prerequisite when an edge is swapped", async () => {
    dbMockState.allQueue = [
      // previous outgoing edges for epic-1
      [{ ticketId: "epic-1", dependsOnTicketId: "epic-2" }],
      // existing-edge probe inside the insert path: none match
      [],
    ];

    const { setTicketDependencies } = await import("@/lib/dependencies/crud");
    setTicketDependencies("proj-1", "epic-1", ["epic-3"]);

    expect(announcedTicketIds()).toEqual(["epic-1", "epic-2", "epic-3"]);
    // One pass, not one emit for the removal and another for the insert.
    expect(mockEmitDependenciesChanged).toHaveBeenCalledTimes(1);
  });

  it("stays silent when a no-op replace changes nothing", async () => {
    dbMockState.allQueue = [[]];

    const { setTicketDependencies } = await import("@/lib/dependencies/crud");
    setTicketDependencies("proj-1", "epic-1", []);

    expect(mockEmitDependenciesChanged).not.toHaveBeenCalled();
  });
});
