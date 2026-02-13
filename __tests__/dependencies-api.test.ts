import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  allQueue: [] as unknown[],
  insertCalls: [] as Array<{ table: unknown; payload: unknown }>,
  deleteCalls: [] as Array<{ table: unknown }>,
}));

const mockIdState = vi.hoisted(() => ({ value: 1 }));

const mockSchema = vi.hoisted(() => ({
  ticketDependencies: { __name: "ticketDependencies" },
  epics: { __name: "epics" },
}));

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
    orderBy: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.get.mockImplementation(() => mockDbState.getQueue.shift() ?? null);
  chain.all.mockImplementation(() => mockDbState.allQueue.shift() ?? []);
  chain.insert.mockImplementation((table: unknown) => ({
    values: vi.fn((payload: unknown) => {
      mockDbState.insertCalls.push({ table, payload });
      return { run: vi.fn() };
    }),
  }));
  chain.delete.mockImplementation((table: unknown) => {
    mockDbState.deleteCalls.push({ table });
    return chain;
  });

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  ticketDependencies: mockSchema.ticketDependencies,
  epics: mockSchema.epics,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => {
    const id = `dep-${mockIdState.value}`;
    mockIdState.value += 1;
    return id;
  }),
}));

// Mock validation module for API tests — we test validation separately
const mockCreateDependencies = vi.hoisted(() => vi.fn());
const mockGetProjectDependencies = vi.hoisted(() => vi.fn());

vi.mock("@/lib/dependencies/crud", () => ({
  createDependencies: mockCreateDependencies,
  getProjectDependencies: mockGetProjectDependencies,
}));

vi.mock("@/lib/dependencies/validation", () => ({
  CycleError: class CycleError extends Error {
    cycle: string[];
    constructor(cycle: string[]) {
      super(`Dependency cycle detected: ${cycle.join(" → ")}`);
      this.name = "CycleError";
      this.cycle = cycle;
    }
  },
  CrossProjectError: class CrossProjectError extends Error {
    constructor(ticketId: string, dependsOnId: string) {
      super(`Cross-project dependency not allowed: ticket "${ticketId}" and "${dependsOnId}" belong to different projects`);
      this.name = "CrossProjectError";
    }
  },
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("GET /api/projects/[projectId]/dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
    mockDbState.allQueue = [];
  });

  it("returns all dependencies for a project", async () => {
    const deps = [
      { id: "d1", ticketId: "A", dependsOnTicketId: "B", projectId: "proj1" },
      { id: "d2", ticketId: "C", dependsOnTicketId: "B", projectId: "proj1" },
    ];
    mockGetProjectDependencies.mockReturnValue(deps);

    const { GET } = await import(
      "@/app/api/projects/[projectId]/dependencies/route"
    );
    const response = await GET(
      mockRequest({}),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    const json = await response.json();
    expect(json.data).toHaveLength(2);
    expect(mockGetProjectDependencies).toHaveBeenCalledWith("proj1");
  });
});

describe("POST /api/projects/[projectId]/dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.insertCalls = [];
    mockIdState.value = 1;
  });

  it("returns 400 when edges array is missing", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/route"
    );
    const response = await POST(
      mockRequest({}),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("edges array is required");
  });

  it("returns 400 when edges array is empty", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/route"
    );
    const response = await POST(
      mockRequest({ edges: [] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for self-referencing dependency", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/route"
    );
    const response = await POST(
      mockRequest({ edges: [{ ticketId: "A", dependsOnTicketId: "A" }] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("cannot depend on itself");
  });

  it("creates dependencies and returns 201", async () => {
    const created = [
      { id: "dep-1", ticketId: "A", dependsOnTicketId: "B", projectId: "proj1" },
    ];
    mockCreateDependencies.mockReturnValue(created);

    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/route"
    );
    const response = await POST(
      mockRequest({ edges: [{ ticketId: "A", dependsOnTicketId: "B" }] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.data).toHaveLength(1);
    expect(mockCreateDependencies).toHaveBeenCalledWith("proj1", [
      { ticketId: "A", dependsOnTicketId: "B" },
    ]);
  });

  it("returns 422 when a cycle is detected", async () => {
    const { CycleError } = await import("@/lib/dependencies/validation");
    mockCreateDependencies.mockImplementation(() => {
      throw new CycleError(["A", "B", "A"]);
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/route"
    );
    const response = await POST(
      mockRequest({ edges: [{ ticketId: "A", dependsOnTicketId: "B" }] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.code).toBe("CYCLE_DETECTED");
    expect(json.cycle).toEqual(["A", "B", "A"]);
  });

  it("returns 422 for cross-project dependency", async () => {
    const { CrossProjectError } = await import("@/lib/dependencies/validation");
    mockCreateDependencies.mockImplementation(() => {
      throw new CrossProjectError("A", "X");
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/route"
    );
    const response = await POST(
      mockRequest({ edges: [{ ticketId: "A", dependsOnTicketId: "X" }] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.code).toBe("CROSS_PROJECT_DEPENDENCY");
  });
});
