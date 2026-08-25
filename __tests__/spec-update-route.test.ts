/**
 * Spec update API route tests:
 *
 *   - POST /api/projects/[projectId]/spec/update:
 *     - 404 when project does not exist
 *     - 400 when project has no git repo configured (requireGitRepo)
 *     - 409 when a spec update is already in progress (SPEC_UPDATE_PENDING)
 *     - 400 when the selected named agent does not exist
 *     - 200 with { data: { sessionId } } on valid dispatch
 *   - GET /api/projects/[projectId]/spec/update:
 *     - 404 when project does not exist
 *     - 200 with { data: { pending: false, sessionId: null, status: null } }
 *     - 200 with { data: { pending: true, sessionId: "...", status: "running" } }
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

vi.mock("@/lib/workflow/spec-update", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/workflow/spec-update")
  >("@/lib/workflow/spec-update");
  return { ...actual, dispatchSpecUpdateSession: dispatchMock };
});

const { db } = await import("@/lib/db");
const { projects, agentSessions } = await import("@/lib/db/schema");
const { POST, GET } = await import(
  "@/app/api/projects/[projectId]/spec/update/route"
);
const { SpecUpdateAgentNotFoundError } = await import(
  "@/lib/workflow/spec-update"
);

let counter = 0;

function seedProject(gitRepoPath: string | null = "/repos/project"): string {
  counter += 1;
  const projectId = `proj-spec-route-${counter}`;
  db.insert(projects)
    .values({ id: projectId, name: "Spec Route Project", gitRepoPath })
    .run();
  return projectId;
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.mockResolvedValue({ sessionId: "spec-session-1" });
});

describe("POST /api/projects/[projectId]/spec/update", () => {
  it("404s when the project is not found", async () => {
    const res = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId: "nonexistent" })
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("not found");
  });

  it("400s when the project has no git repository path configured", async () => {
    const projectId = seedProject(null);
    const res = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("no git repository path");
  });

  it("409s with SPEC_UPDATE_PENDING when an update is already running", async () => {
    const projectId = seedProject();
    db.insert(agentSessions)
      .values({
        id: `sess-pending-${counter}`,
        projectId,
        status: "running",
        agentType: "spec_generation",
        createdAt: new Date().toISOString(),
      })
      .run();

    const res = await POST(
      mockJsonRequest({}),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("SPEC_UPDATE_PENDING");
    expect(json.error).toContain("already in progress");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("400s when the named agent selection is stale/nonexistent", async () => {
    const projectId = seedProject();
    dispatchMock.mockRejectedValueOnce(
      new SpecUpdateAgentNotFoundError("agent-dead")
    );

    const res = await POST(
      mockJsonRequest({ namedAgentId: "agent-dead" }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("selected agent no longer exists");
  });

  it("dispatches successfully and returns the session id", async () => {
    const projectId = seedProject();

    const res = await POST(
      mockJsonRequest({
        instruction: "refresh architecture",
        namedAgentId: "picked-agent",
      }),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ sessionId: "spec-session-1" });
    expect(dispatchMock).toHaveBeenCalledWith({
      projectId,
      instruction: "refresh architecture",
      namedAgentId: "picked-agent",
    });
  });
});

describe("GET /api/projects/[projectId]/spec/update", () => {
  it("404s when the project is not found", async () => {
    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId: "nonexistent" })
    );
    expect(res.status).toBe(404);
  });

  it("returns pending: false when no spec update is active", async () => {
    const projectId = seedProject();
    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({
      pending: false,
      sessionId: null,
      status: null,
    });
  });

  it("returns pending: true and session details when an update is queued or running", async () => {
    const projectId = seedProject();
    db.insert(agentSessions)
      .values({
        id: "sess-active-123",
        projectId,
        status: "running",
        agentType: "spec_generation",
        createdAt: new Date().toISOString(),
      })
      .run();

    const res = await GET(
      mockNextRequest(),
      mockRouteContext({ projectId })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({
      pending: true,
      sessionId: "sess-active-123",
      status: "running",
    });
  });
});
