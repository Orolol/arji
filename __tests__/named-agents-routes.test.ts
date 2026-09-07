/**
 * Tests for Named Agents API routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockJsonRequest,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockList = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockDelete = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-config/named-agents", () => ({
  listNamedAgents: mockList,
  createNamedAgent: mockCreate,
  getNamedAgent: mockGet,
  updateNamedAgent: mockUpdate,
  deleteNamedAgent: mockDelete,
}));

// PARTIAL mock: only the provider/type predicates are widened (this suite
// exercises historical provider strings the registry no longer lists). Every
// other constant — the composite kind the route discriminates on among them —
// comes from the real module, so a rename there fails here rather than
// silently un-defining a branch.
vi.mock("@/lib/agent-config/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-config/constants")>()),
  isAgentProvider: vi.fn(
    (v: string) => [
      "claude-code", "codex", "gemini-cli",
      "mistral-vibe", "qwen-code", "opencode",
      "deepseek", "kimi", "zai",
      "pi", "oh-my-pi",
    ].includes(v)
  ),
  isAgentType: vi.fn(() => true),
}));

describe("Named Agents API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/agent-config/named-agents", () => {
    it("returns list of named agents", async () => {
      const agents = [
        { id: "a1", name: "Agent A", provider: "claude-code", model: "m1", createdAt: "2026-01-01" },
      ];
      mockList.mockReturnValue(agents);

      const { GET } = await import("@/app/api/agent-config/named-agents/route");
      const res = await GET();
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data).toEqual(agents);
    });

    it("returns 500 on error", async () => {
      mockList.mockImplementation(() => {
        throw new Error("DB error");
      });

      const { GET } = await import("@/app/api/agent-config/named-agents/route");
      const res = await GET();
      const json = await res.json();

      expect(res.status).toBe(500);
      expect(json.error).toBe("DB error");
    });
  });

  describe("POST /api/agent-config/named-agents", () => {
    it("creates a named agent", async () => {
      const created = {
        id: "a1",
        name: "CC Opus",
        provider: "claude-code",
        model: "claude-opus-4-6",
        createdAt: "2026-01-01",
      };
      mockCreate.mockReturnValue({ data: created });

      const { POST } = await import("@/app/api/agent-config/named-agents/route");
      const res = await POST(mockJsonRequest({
        name: "CC Opus",
        provider: "claude-code",
        model: "claude-opus-4-6",
      }));
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.data).toEqual(created);
    });

    it("validates name is required", async () => {
      const { POST } = await import("@/app/api/agent-config/named-agents/route");
      const res = await POST(mockJsonRequest({ provider: "claude-code", model: "m1" }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe("Validation failed");
      expect(json.details.name[0]).toContain("name");
    });

    it("validates provider is valid", async () => {
      const { POST } = await import("@/app/api/agent-config/named-agents/route");
      const res = await POST(mockJsonRequest({
        name: "Test",
        provider: "invalid",
        model: "m1",
      }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error).toBe("Validation failed");
      expect(json.details.provider[0]).toContain("provider");
    });

    it("creates a named agent without a model (CLI default)", async () => {
      const created = {
        id: "a2",
        name: "Test",
        provider: "claude-code",
        model: "",
        createdAt: "2026-01-01",
      };
      mockCreate.mockReturnValue({ data: created });

      const { POST } = await import("@/app/api/agent-config/named-agents/route");
      const res = await POST(mockJsonRequest({
        name: "Test",
        provider: "claude-code",
      }));
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.data).toEqual(created);
    });

    it("returns 409 for duplicate name", async () => {
      mockCreate.mockImplementation(() => {
        throw new Error('A named agent with name "CC Opus" already exists');
      });

      const { POST } = await import("@/app/api/agent-config/named-agents/route");
      const res = await POST(mockJsonRequest({
        name: "CC Opus",
        provider: "claude-code",
        model: "m1",
      }));
      const json = await res.json();

      expect(res.status).toBe(409);
      expect(json.error).toContain("already exists");
    });

    it("accepts gemini-cli provider", async () => {
      const created = {
        id: "a2",
        name: "Gemini Flash",
        provider: "gemini-cli",
        model: "gemini-2.0-flash",
        createdAt: "2026-01-01",
      };
      mockCreate.mockReturnValue({ data: created });

      const { POST } = await import("@/app/api/agent-config/named-agents/route");
      const res = await POST(mockJsonRequest({
        name: "Gemini Flash",
        provider: "gemini-cli",
        model: "gemini-2.0-flash",
      }));
      const json = await res.json();

      expect(res.status).toBe(201);
      expect(json.data.provider).toBe("gemini-cli");
    });
  });

  describe("GET /api/agent-config/named-agents/[agentId]", () => {
    it("returns agent when found", async () => {
      const agent = { id: "a1", name: "Test", provider: "claude-code", model: "m1" };
      mockGet.mockReturnValue(agent);

      const { GET } = await import("@/app/api/agent-config/named-agents/[agentId]/route");
      const res = await GET(mockNextRequest(), mockRouteContext({ agentId: "a1" }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data).toEqual(agent);
    });

    it("returns 404 when not found", async () => {
      mockGet.mockReturnValue(undefined);

      const { GET } = await import("@/app/api/agent-config/named-agents/[agentId]/route");
      const res = await GET(mockNextRequest(), mockRouteContext({ agentId: "nonexistent" }));

      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/agent-config/named-agents/[agentId]", () => {
    it("updates a named agent", async () => {
      const updated = { id: "a1", name: "Updated", provider: "claude-code", model: "m1" };
      mockUpdate.mockReturnValue({ data: updated });

      const { PUT } = await import("@/app/api/agent-config/named-agents/[agentId]/route");
      const res = await PUT(mockJsonRequest({ name: "Updated" }), mockRouteContext({ agentId: "a1" }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.name).toBe("Updated");
    });

    it("returns 404 when agent not found", async () => {
      mockUpdate.mockImplementation(() => {
        throw new Error("Named agent not found: a1");
      });

      const { PUT } = await import("@/app/api/agent-config/named-agents/[agentId]/route");
      const res = await PUT(mockJsonRequest({ name: "Test" }), mockRouteContext({ agentId: "a1" }));

      expect(res.status).toBe(404);
    });

    it("returns 409 for duplicate name", async () => {
      mockUpdate.mockImplementation(() => {
        throw new Error('A named agent with name "Taken" already exists');
      });

      const { PUT } = await import("@/app/api/agent-config/named-agents/[agentId]/route");
      const res = await PUT(mockJsonRequest({ name: "Taken" }), mockRouteContext({ agentId: "a1" }));

      expect(res.status).toBe(409);
    });

    it("validates provider when provided", async () => {
      const { PUT } = await import("@/app/api/agent-config/named-agents/[agentId]/route");
      const res = await PUT(mockJsonRequest({ provider: "invalid" }), mockRouteContext({ agentId: "a1" }));

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("Validation failed");
      expect(json.details.provider[0]).toContain("provider");
    });
  });

  describe("DELETE /api/agent-config/named-agents/[agentId]", () => {
    it("deletes an agent", async () => {
      mockDelete.mockReturnValue(true);

      const { DELETE } = await import("@/app/api/agent-config/named-agents/[agentId]/route");
      const res = await DELETE(mockNextRequest(), mockRouteContext({ agentId: "a1" }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.ok).toBe(true);
    });

    it("returns 404 when agent not found", async () => {
      mockDelete.mockReturnValue(false);

      const { DELETE } = await import("@/app/api/agent-config/named-agents/[agentId]/route");
      const res = await DELETE(mockNextRequest(), mockRouteContext({ agentId: "nonexistent" }));

      expect(res.status).toBe(404);
    });
  });
});
