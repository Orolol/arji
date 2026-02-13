import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.get.mockImplementation(() => mockDbState.getQueue.shift() ?? null);
  chain.all.mockReturnValue([]);
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  epics: { __name: "epics" },
  ticketDependencies: { __name: "ticketDependencies" },
}));

const mockGetTicketDependencies = vi.hoisted(() => vi.fn(() => []));
const mockGetTicketDependents = vi.hoisted(() => vi.fn(() => []));
const mockSetTicketDependencies = vi.hoisted(() => vi.fn(() => []));

vi.mock("@/lib/dependencies/validation", () => ({
  getTicketDependencies: mockGetTicketDependencies,
  getTicketDependents: mockGetTicketDependents,
  CycleError: class CycleError extends Error {
    cycle: string[];
    constructor(cycle: string[]) {
      super(`Dependency cycle detected: ${cycle.join(" → ")}`);
      this.name = "CycleError";
      this.cycle = cycle;
    }
  },
  CrossProjectError: class CrossProjectError extends Error {
    constructor(a: string, b: string) {
      super(`Cross-project: ${a} and ${b}`);
      this.name = "CrossProjectError";
    }
  },
}));

vi.mock("@/lib/dependencies/crud", () => ({
  setTicketDependencies: mockSetTicketDependencies,
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

const routeParams = {
  params: Promise.resolve({ projectId: "proj1", epicId: "epic-1" }),
};

describe("GET /api/projects/[projectId]/epics/[epicId]/dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
  });

  it("returns 404 when epic not found", async () => {
    mockDbState.getQueue = []; // no epic found

    const { GET } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/dependencies/route"
    );
    const res = await GET(mockRequest({}), routeParams);
    expect(res.status).toBe(404);
  });

  it("returns predecessors and successors", async () => {
    mockDbState.getQueue = [{ id: "epic-1", projectId: "proj1" }];
    mockGetTicketDependencies.mockReturnValue([
      { id: "d1", ticketId: "epic-1", dependsOnTicketId: "epic-2" },
    ]);
    mockGetTicketDependents.mockReturnValue([
      { id: "d2", ticketId: "epic-3", dependsOnTicketId: "epic-1" },
    ]);

    const { GET } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/dependencies/route"
    );
    const res = await GET(mockRequest({}), routeParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.predecessors).toHaveLength(1);
    expect(json.data.successors).toHaveLength(1);
  });
});

describe("PUT /api/projects/[projectId]/epics/[epicId]/dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
  });

  it("returns 400 when dependsOnIds is not an array", async () => {
    const { PUT } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/dependencies/route"
    );
    const res = await PUT(mockRequest({}), routeParams);
    expect(res.status).toBe(400);
  });

  it("returns 404 when epic not found", async () => {
    mockDbState.getQueue = []; // no epic

    const { PUT } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/dependencies/route"
    );
    const res = await PUT(
      mockRequest({ dependsOnIds: ["epic-2"] }),
      routeParams
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for self-dependency", async () => {
    mockDbState.getQueue = [{ id: "epic-1", projectId: "proj1" }];

    const { PUT } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/dependencies/route"
    );
    const res = await PUT(
      mockRequest({ dependsOnIds: ["epic-1"] }),
      routeParams
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("cannot depend on itself");
  });

  it("saves dependencies successfully", async () => {
    mockDbState.getQueue = [{ id: "epic-1", projectId: "proj1" }];
    mockSetTicketDependencies.mockReturnValue([
      { id: "dep-1", ticketId: "epic-1", dependsOnTicketId: "epic-2" },
    ]);

    const { PUT } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/dependencies/route"
    );
    const res = await PUT(
      mockRequest({ dependsOnIds: ["epic-2"] }),
      routeParams
    );

    expect(res.status).toBe(200);
    expect(mockSetTicketDependencies).toHaveBeenCalledWith(
      "proj1",
      "epic-1",
      ["epic-2"]
    );
  });

  it("returns 422 on cycle detection", async () => {
    mockDbState.getQueue = [{ id: "epic-1", projectId: "proj1" }];
    const { CycleError } = await import("@/lib/dependencies/validation");
    mockSetTicketDependencies.mockImplementation(() => {
      throw new CycleError(["epic-1", "epic-2", "epic-1"]);
    });

    const { PUT } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/dependencies/route"
    );
    const res = await PUT(
      mockRequest({ dependsOnIds: ["epic-2"] }),
      routeParams
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe("CYCLE_DETECTED");
    expect(json.cycle).toEqual(["epic-1", "epic-2", "epic-1"]);
  });
});
