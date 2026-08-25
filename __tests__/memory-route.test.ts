/**
 * Learned project memory — API routes against the real migrated schema:
 *
 *   - GET/PUT /api/projects/[projectId]/memory: doc edit round-trip, empty
 *     state, manual-editor cap REJECTION (400, never silent truncation),
 *     envelope shapes, project 404,
 *   - POST /api/projects/[projectId]/memory/distill: manual dispatch wiring
 *     (validated body -> dispatchMemoryDistillSession), source-session
 *     scoping 404, and the 409 pending-distill conflict.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mockJsonRequest,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

// Keep hasPendingMemoryDistill (and the rest of the module) real — only the
// dispatch itself is stubbed; its full behavior is covered by
// memory-distill-dispatch.test.ts.
vi.mock("@/lib/workflow/memory-distill", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/workflow/memory-distill")
  >("@/lib/workflow/memory-distill");
  return { ...actual, dispatchMemoryDistillSession: dispatchMock };
});

const { db } = await import("@/lib/db");
const { projects, agentSessions } = await import("@/lib/db/schema");
const { PROJECT_MEMORY_MAX_CHARS } = await import(
  "@/lib/documents/memory-constants"
);
const { GET, PUT } = await import(
  "@/app/api/projects/[projectId]/memory/route"
);
const { POST: DISTILL } = await import(
  "@/app/api/projects/[projectId]/memory/distill/route"
);

let counter = 0;

function seedProject(): string {
  counter += 1;
  const projectId = `proj-mem-route-${counter}`;
  db.insert(projects).values({ id: projectId, name: "Route Project" }).run();
  return projectId;
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.mockResolvedValue({ sessionId: "distill-session-1" });
});

describe("GET /api/projects/[projectId]/memory", () => {
  it("404s for an unknown project", async () => {
    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: "missing" })
    );
    expect(res.status).toBe(404);
  });

  it("returns the empty state when no memory doc exists", async () => {
    const projectId = seedProject();
    const res = await GET(mockNextRequest(), mockRouteContext({ projectId }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      content: "",
      exists: false,
      updatedAt: null,
      maxChars: PROJECT_MEMORY_MAX_CHARS,
    });
  });
});

describe("PUT /api/projects/[projectId]/memory (edit round-trip)", () => {
  it("saves and reads back the memory content", async () => {
    const projectId = seedProject();

    const putRes = await PUT(
      mockJsonRequest({ content: "## Rules\n\n- envelope responses" }),
      mockRouteContext({ projectId })
    );
    const putJson = await putRes.json();
    expect(putRes.status).toBe(200);
    expect(putJson.data.exists).toBe(true);
    expect(putJson.data.content).toBe("## Rules\n\n- envelope responses");

    const getRes = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId })
    );
    const getJson = await getRes.json();
    expect(getJson.data.content).toBe("## Rules\n\n- envelope responses");
    expect(getJson.data.exists).toBe(true);
    expect(getJson.data.updatedAt).toBeTruthy();
  });

  it("replaces on a second save and allows clearing with an empty string", async () => {
    const projectId = seedProject();
    await PUT(mockJsonRequest({ content: "v1" }), mockRouteContext({ projectId }));
    await PUT(mockJsonRequest({ content: "" }), mockRouteContext({ projectId }));

    const res = await GET(mockNextRequest(), mockRouteContext({ projectId }));
    const json = await res.json();
    expect(json.data.content).toBe("");
    expect(json.data.exists).toBe(true);
  });

  it("REJECTS content over the cap with 400 (no silent truncation)", async () => {
    const projectId = seedProject();
    const res = await PUT(
      mockJsonRequest({ content: "x".repeat(PROJECT_MEMORY_MAX_CHARS + 1) }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(400);

    const getRes = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId })
    );
    expect((await getRes.json()).data.exists).toBe(false);
  });

  it("accepts content at exactly the cap", async () => {
    const projectId = seedProject();
    const res = await PUT(
      mockJsonRequest({ content: "y".repeat(PROJECT_MEMORY_MAX_CHARS) }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
  });

  it("400s on malformed bodies", async () => {
    const projectId = seedProject();
    for (const body of [{}, { content: 42 }, { nope: "x" }]) {
      const res = await PUT(mockJsonRequest(body), mockRouteContext({ projectId }));
      expect(res.status).toBe(400);
    }
  });

  it("404s for an unknown project", async () => {
    const res = await PUT(
      mockJsonRequest({ content: "x" }),
      mockRouteContext({ projectId: "missing" })
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /api/projects/[projectId]/memory/distill", () => {
  it("dispatches a distill session and returns its id", async () => {
    const projectId = seedProject();
    db.insert(agentSessions)
      .values({ id: "src-1", projectId, status: "completed" })
      .run();

    const res = await DISTILL(
      mockJsonRequest({ sourceSessionId: "src-1" }),
      mockRouteContext({ projectId })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ sessionId: "distill-session-1" });
    expect(dispatchMock).toHaveBeenCalledWith({
      projectId,
      sourceSessionId: "src-1",
      namedAgentId: null,
    });
  });

  it("dispatches without a source session (body optional)", async () => {
    const projectId = seedProject();
    const res = await DISTILL(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledWith({
      projectId,
      sourceSessionId: null,
      namedAgentId: null,
    });
  });

  /**
   * The UI only offers "Distill learnings" on a completed, non-memory-writer
   * session — but the endpoint must not depend on the UI for that. A direct
   * POST could otherwise distill a dream (whose output IS the memory) or a run
   * that never finished.
   */
  it.each(["dreaming", "memory_distill"])(
    "400s when the source is a %s session",
    async (agentType) => {
      const projectId = seedProject();
      db.insert(agentSessions)
        .values({
          id: `src-writer-${agentType}`,
          projectId,
          status: "completed",
          agentType,
        })
        .run();

      const res = await DISTILL(
        mockJsonRequest({ sourceSessionId: `src-writer-${agentType}` }),
        mockRouteContext({ projectId })
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe("MEMORY_DISTILL_SOURCE_INVALID");
      expect(json.error).toContain("cannot itself be distilled");
      expect(dispatchMock).not.toHaveBeenCalled();
    }
  );

  it.each(["queued", "running", "failed", "cancelled"])(
    "400s when the source session is %s rather than completed",
    async (status) => {
      const projectId = seedProject();
      db.insert(agentSessions)
        .values({
          id: `src-${status}`,
          projectId,
          status,
          agentType: "build",
        })
        .run();

      const res = await DISTILL(
        mockJsonRequest({ sourceSessionId: `src-${status}` }),
        mockRouteContext({ projectId })
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.code).toBe("MEMORY_DISTILL_SOURCE_INVALID");
      expect(json.error).toContain(status);
      expect(dispatchMock).not.toHaveBeenCalled();
    }
  );

  /**
   * `asked_question` rows are `completed` too, so the status check alone lets
   * them through — and the agent is still waiting for a reply that never came.
   */
  it("400s when the source session stopped to ask a question", async () => {
    const projectId = seedProject();
    db.insert(agentSessions)
      .values({
        id: "src-asked",
        projectId,
        status: "completed",
        agentType: "build",
        outcome: "asked_question",
      })
      .run();

    const res = await DISTILL(
      mockJsonRequest({ sourceSessionId: "src-asked" }),
      mockRouteContext({ projectId })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("MEMORY_DISTILL_SOURCE_INVALID");
    expect(json.error).toContain("ask a question");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("still accepts a completed review as a source — the manual button is offered there", async () => {
    const projectId = seedProject();
    db.insert(agentSessions)
      .values({
        id: "src-review",
        projectId,
        status: "completed",
        agentType: "review_code",
      })
      .run();

    const res = await DISTILL(
      mockJsonRequest({ sourceSessionId: "src-review" }),
      mockRouteContext({ projectId })
    );

    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalled();
  });

  it("404s when the source session belongs to another project", async () => {
    const projectId = seedProject();
    const otherProjectId = seedProject();
    db.insert(agentSessions)
      .values({ id: "src-foreign", projectId: otherProjectId, status: "completed" })
      .run();

    const res = await DISTILL(
      mockJsonRequest({ sourceSessionId: "src-foreign" }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(404);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("409s when a distill session is already queued or running", async () => {
    const projectId = seedProject();
    db.insert(agentSessions)
      .values({
        id: "pending-distill",
        projectId,
        status: "queued",
        agentType: "memory_distill",
      })
      .run();

    const res = await DISTILL(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("MEMORY_DISTILL_PENDING");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown project", async () => {
    const res = await DISTILL(
      mockJsonRequest({}),
      mockRouteContext({ projectId: "missing" })
    );
    expect(res.status).toBe(404);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("500s with the envelope when dispatch fails", async () => {
    const projectId = seedProject();
    dispatchMock.mockRejectedValueOnce(new Error("scheduler exploded"));

    const res = await DISTILL(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.error).toBe("scheduler exploded");
  });
});
