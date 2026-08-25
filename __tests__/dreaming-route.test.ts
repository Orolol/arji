/**
 * Dreaming — the manual trigger's HTTP contract
 * (POST /api/projects/[projectId]/memory/dream).
 *
 * The dispatch logic is covered by dreaming-dispatch.test.ts; what this file
 * pins is the ENVELOPE, because the route has three success-ish answers that
 * are easy to conflate:
 *   - a dream was dispatched      -> 200 { sessionId, dispatched: true },
 *   - nothing new to dream about  -> 200 { sessionId: null, reason },
 *   - a memory writer holds the doc -> 409 DREAMING_PENDING,
 * plus the ordinary 404 / 400 shapes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockJsonRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const dispatchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

// hasPendingMemoryWriter stays REAL (it is half the contract under test);
// only the dispatch itself is stubbed.
vi.mock("@/lib/workflow/dreaming", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/workflow/dreaming")>(
      "@/lib/workflow/dreaming"
    );
  return { ...actual, dispatchDreamingSession: dispatchMock };
});

const { db } = await import("@/lib/db");
const { projects, agentSessions } = await import("@/lib/db/schema");
const { POST } = await import(
  "@/app/api/projects/[projectId]/memory/dream/route"
);

let counter = 0;

function seedProject(): string {
  counter += 1;
  const projectId = `proj-dream-route-${counter}`;
  db.insert(projects).values({ id: projectId, name: "Route Project" }).run();
  return projectId;
}

function seedWriterSession(projectId: string, agentType: string) {
  counter += 1;
  db.insert(agentSessions)
    .values({
      id: `writer-${counter}`,
      projectId,
      status: "running",
      agentType,
      createdAt: new Date().toISOString(),
    })
    .run();
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.mockResolvedValue({
    sessionId: "dream-session-1",
    dispatched: true,
    reason: "eligible",
    sessionsAnalyzed: 7,
  });
});

describe("POST /api/projects/[projectId]/memory/dream", () => {
  it("dispatches and returns the session envelope", async () => {
    const projectId = seedProject();

    const res = await POST(mockJsonRequest({}), mockRouteContext({ projectId }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      sessionId: "dream-session-1",
      dispatched: true,
      reason: "eligible",
      sessionsAnalyzed: 7,
    });
    expect(dispatchMock).toHaveBeenCalledWith({
      projectId,
      namedAgentId: null,
      trigger: "manual",
    });
  });

  it("passes an explicit named agent through", async () => {
    const projectId = seedProject();

    await POST(
      mockJsonRequest({ namedAgentId: "agent-7" }),
      mockRouteContext({ projectId })
    );

    expect(dispatchMock).toHaveBeenCalledWith({
      projectId,
      namedAgentId: "agent-7",
      trigger: "manual",
    });
  });

  /**
   * "Nothing changed since the last dream" is a correct answer, not a fault:
   * 200 with a null session and the reason, so the UI can say so inline.
   */
  it("answers 200 with a null session for the journalled no-op", async () => {
    const projectId = seedProject();
    dispatchMock.mockResolvedValue({
      sessionId: null,
      dispatched: false,
      reason: "no new sessions since the last dream",
      sessionsAnalyzed: 0,
    });

    const res = await POST(mockJsonRequest({}), mockRouteContext({ projectId }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.sessionId).toBeNull();
    expect(body.data.dispatched).toBe(false);
    expect(body.data.reason).toContain("no new sessions");
  });

  it("answers 409 when a dream already holds the document", async () => {
    const projectId = seedProject();
    seedWriterSession(projectId, "dreaming");

    const res = await POST(mockJsonRequest({}), mockRouteContext({ projectId }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("DREAMING_PENDING");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("answers 409 when a DISTILL holds the document", async () => {
    const projectId = seedProject();
    seedWriterSession(projectId, "memory_distill");

    const res = await POST(mockJsonRequest({}), mockRouteContext({ projectId }));

    expect(res.status).toBe(409);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  /**
   * The last-moment race: the pre-check passed, then the dispatcher lost the
   * document. One contract for "a writer holds the memory", not two.
   */
  it("answers 409 when the dispatcher loses the final race", async () => {
    const projectId = seedProject();
    dispatchMock.mockResolvedValue({
      sessionId: null,
      dispatched: false,
      reason:
        "a memory rewrite (distill or dream) is already pending for this project",
      sessionsAnalyzed: 0,
    });

    const res = await POST(mockJsonRequest({}), mockRouteContext({ projectId }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("DREAMING_PENDING");
  });

  it("404s for an unknown project without dispatching", async () => {
    const res = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId: "nope" })
    );

    expect(res.status).toBe(404);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("400s on an invalid body", async () => {
    const projectId = seedProject();

    const res = await POST(
      mockJsonRequest({ namedAgentId: "" }),
      mockRouteContext({ projectId })
    );

    expect(res.status).toBe(400);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected dispatch failure as an error envelope", async () => {
    const projectId = seedProject();
    dispatchMock.mockRejectedValue(new Error("boom"));

    const res = await POST(mockJsonRequest({}), mockRouteContext({ projectId }));
    const body = await res.json();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(body.error).toBeTruthy();
  });
});
