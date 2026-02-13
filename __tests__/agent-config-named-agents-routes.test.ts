import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNamedAgents = vi.hoisted(() => ({
  listNamedAgents: vi.fn(),
  createNamedAgent: vi.fn(),
  updateNamedAgent: vi.fn(),
  deleteNamedAgent: vi.fn(),
}));

vi.mock("@/lib/agent-config/named-agents", () => ({
  listNamedAgents: mockNamedAgents.listNamedAgents,
  createNamedAgent: mockNamedAgents.createNamedAgent,
  updateNamedAgent: mockNamedAgents.updateNamedAgent,
  deleteNamedAgent: mockNamedAgents.deleteNamedAgent,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "na-1"),
}));

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("Named agents routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNamedAgents.listNamedAgents.mockResolvedValue([]);
    mockNamedAgents.createNamedAgent.mockResolvedValue({ data: null, error: "name is required" });
    mockNamedAgents.updateNamedAgent.mockResolvedValue({ data: null, error: "Named agent not found" });
    mockNamedAgents.deleteNamedAgent.mockResolvedValue(false);
  });

  it("GET returns named agents", async () => {
    mockNamedAgents.listNamedAgents.mockResolvedValue([
      {
        id: "na-1",
        name: "Gemini Fast",
        provider: "gemini-cli",
        model: "gemini-2.0-flash",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const { GET } = await import("@/app/api/agent-config/named-agents/route");
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data[0].name).toBe("Gemini Fast");
  });

  it("POST creates named agent", async () => {
    mockNamedAgents.createNamedAgent.mockResolvedValue({
      data: {
        id: "na-1",
        name: "Gemini Fast",
        provider: "gemini-cli",
        model: "gemini-2.0-flash",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const { POST } = await import("@/app/api/agent-config/named-agents/route");
    const res = await POST(
      mockRequest({
        name: "Gemini Fast",
        provider: "gemini-cli",
        model: "gemini-2.0-flash",
      })
    );
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.provider).toBe("gemini-cli");
  });

  it("PATCH returns 404 when named agent is missing", async () => {
    const { PATCH } = await import(
      "@/app/api/agent-config/named-agents/[agentId]/route"
    );

    const res = await PATCH(mockRequest({ name: "Updated" }), {
      params: Promise.resolve({ agentId: "na-missing" }),
    });

    expect(res.status).toBe(404);
  });

  it("DELETE returns 404 when named agent is missing", async () => {
    const { DELETE } = await import(
      "@/app/api/agent-config/named-agents/[agentId]/route"
    );

    const res = await DELETE({} as import("next/server").NextRequest, {
      params: Promise.resolve({ agentId: "na-missing" }),
    });

    expect(res.status).toBe(404);
  });
});
