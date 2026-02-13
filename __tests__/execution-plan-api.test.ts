import { describe, expect, it, vi, beforeEach } from "vitest";

const mockBuildExecutionPlan = vi.hoisted(() => vi.fn());

vi.mock("@/lib/dependencies/scheduler", () => ({
  buildExecutionPlan: mockBuildExecutionPlan,
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("POST /api/projects/[projectId]/dependencies/plan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when ticketIds is missing", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/plan/route"
    );
    const res = await POST(
      mockRequest({}),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when ticketIds is empty", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/plan/route"
    );
    const res = await POST(
      mockRequest({ ticketIds: [] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns execution plan with layers", async () => {
    mockBuildExecutionPlan.mockReturnValue({
      layers: [["a", "c"], ["b", "d"]],
      ticketStatus: new Map([
        ["a", "pending"],
        ["b", "pending"],
        ["c", "pending"],
        ["d", "pending"],
      ]),
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/plan/route"
    );
    const res = await POST(
      mockRequest({ ticketIds: ["a", "b", "c", "d"] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.layers).toEqual([["a", "c"], ["b", "d"]]);
    expect(json.data.layerCount).toBe(2);
    expect(json.data.ticketCount).toBe(4);
  });

  it("returns single layer for independent tickets", async () => {
    mockBuildExecutionPlan.mockReturnValue({
      layers: [["x", "y", "z"]],
      ticketStatus: new Map([
        ["x", "pending"],
        ["y", "pending"],
        ["z", "pending"],
      ]),
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/plan/route"
    );
    const res = await POST(
      mockRequest({ ticketIds: ["x", "y", "z"] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    const json = await res.json();
    expect(json.data.layers).toEqual([["x", "y", "z"]]);
    expect(json.data.layerCount).toBe(1);
  });

  it("returns 500 on internal error", async () => {
    mockBuildExecutionPlan.mockImplementation(() => {
      throw new Error("Graph computation failed");
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/dependencies/plan/route"
    );
    const res = await POST(
      mockRequest({ ticketIds: ["a"] }),
      { params: Promise.resolve({ projectId: "proj1" }) }
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toContain("Graph computation failed");
  });
});
