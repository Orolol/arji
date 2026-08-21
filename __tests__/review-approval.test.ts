/**
 * Tests for Story 5: Review Completion & Approval.
 *
 * Validates that the approve route resolves all open review comments,
 * posts an approval activity comment, and sets statuses to done.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

const mockEpic = {
  id: "epic-1",
  title: "Test Epic",
  branchName: "feature/epic-abc",
  status: "review",
};

const mockProject = {
  id: "p1",
  gitRepoPath: "/tmp/repo",
};

let insertCalls: { table: string; values: Record<string, unknown> }[] = [];
let updateCalls: { table: string; updates: Record<string, unknown> }[] = [];

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn(function (this: typeof chain, table: { _name?: string }) {
      // Return different data based on table
      (this as Record<string, unknown>)._currentTable = table?._name;
      return this;
    }),
    where: vi.fn(function (this: typeof chain) {
      return this;
    }),
    orderBy: vi.fn(function (this: typeof chain) {
      return this;
    }),
    get: vi.fn(function (this: typeof chain & { _currentTable?: string }) {
      if (this._currentTable === "projects") return mockProject;
      return mockEpic;
    }),
    all: vi.fn(function (this: typeof chain & { _currentTable?: string }) {
      if (this._currentTable === "userStories") {
        return [{ id: "story-1", epicId: "epic-1", status: "review" }];
      }
      return [];
    }),
    insert: vi.fn((table: { _name?: string }) => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        insertCalls.push({ table: table?._name ?? "unknown", values: vals });
        return { run: vi.fn() };
      }),
    })),
    update: vi.fn((table: { _name?: string }) => ({
      set: vi.fn((updates: Record<string, unknown>) => {
        updateCalls.push({ table: table?._name ?? "unknown", updates });
        return {
          where: vi.fn().mockReturnValue({ run: vi.fn() }),
        };
      }),
    })),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
  };
  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  reviewComments: {
    _name: "reviewComments",
    id: "id",
    epicId: "epicId",
    status: "status",
    updatedAt: "updatedAt",
  },
  epics: {
    _name: "epics",
    id: "id",
    status: "status",
    updatedAt: "updatedAt",
  },
  userStories: {
    _name: "userStories",
    id: "id",
    epicId: "epicId",
    status: "status",
  },
  projects: {
    _name: "projects",
    id: "id",
  },
  ticketComments: {
    _name: "ticketComments",
    id: "id",
    epicId: "epicId",
    author: "author",
    content: "content",
    createdAt: "createdAt",
  },
  ticketActivityLog: {
    _name: "ticketActivityLog",
    id: "id",
    projectId: "projectId",
    epicId: "epicId",
    fromStatus: "fromStatus",
    toStatus: "toStatus",
    actor: "actor",
    reason: "reason",
    sessionId: "sessionId",
    createdAt: "createdAt",
  },
  agentSessions: {
    _name: "agentSessions",
    id: "id",
    epicId: "epicId",
    projectId: "projectId",
    status: "status",
    agentType: "agentType",
  },
}));

vi.mock("@/lib/workflow/engine", () => ({
  validateTransition: vi.fn(() => ({ valid: true })),
  isAllowedTransition: vi.fn(() => true),
}));

vi.mock("@/lib/workflow/context", () => ({
  buildTransitionContext: vi.fn(() => ({
    epicId: "epic-1",
    fromStatus: "review",
    toStatus: "done",
    hasOpenReviewComments: false,
    hasCompletedReview: true,
    hasRunningSession: false,
    actor: "user",
    source: "approve",
  })),
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "new-id"),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock("simple-git", () => ({
  default: vi.fn(() => ({
    merge: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: vi.fn(),
}));

vi.mock("@/lib/workflow/log", () => ({
  logTransition: vi.fn(),
}));

vi.mock("@/lib/events/emit", () => ({
  emitTicketMoved: vi.fn(),
}));

describe("Review approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertCalls = [];
    updateCalls = [];
  });

  it("resolves all open review comments on approve", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
    );

    const req = mockNextRequest({ url: "http://localhost/api/test", method: "POST" });

    const res = await POST(req, mockRouteContext({ projectId: "p1", epicId: "epic-1" }));

    expect(res.status).toBe(200);

    // Check that reviewComments were updated with status: resolved
    const reviewUpdate = updateCalls.find(
      (c) => c.table === "reviewComments"
    );
    expect(reviewUpdate).toBeDefined();
    expect(reviewUpdate!.updates.status).toBe("resolved");
  });

  it("posts an approval activity comment to ticket comments", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
    );

    const req = mockNextRequest({ url: "http://localhost/api/test", method: "POST" });

    await POST(req, mockRouteContext({ projectId: "p1", epicId: "epic-1" }));

    const ticketInsert = insertCalls.find(
      (c) => c.table === "ticketComments"
    );
    expect(ticketInsert).toBeDefined();
    expect(ticketInsert!.values.content).toContain("approved");
    expect(ticketInsert!.values.author).toBe("user");
  });

  it("sets epic status to done", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
    );

    const req = mockNextRequest({ url: "http://localhost/api/test", method: "POST" });

    await POST(req, mockRouteContext({ projectId: "p1", epicId: "epic-1" }));

    const epicUpdate = updateCalls.find(
      (c) => c.table === "epics" && c.updates.status === "done"
    );
    expect(epicUpdate).toBeDefined();
  });

  it("sets all user stories to done", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
    );

    const req = mockNextRequest({ url: "http://localhost/api/test", method: "POST" });

    await POST(req, mockRouteContext({ projectId: "p1", epicId: "epic-1" }));

    const usUpdate = updateCalls.find(
      (c) => c.table === "userStories" && c.updates.status === "done"
    );
    expect(usUpdate).toBeDefined();
  });

  it("returns approved and merged status", async () => {
    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
    );

    const req = mockNextRequest({ url: "http://localhost/api/test", method: "POST" });

    const res = await POST(req, mockRouteContext({ projectId: "p1", epicId: "epic-1" }));

    const json = await res.json();
    expect(json.data.approved).toBe(true);
    expect(typeof json.data.merged).toBe("boolean");
  });

  it("rejects approval when epic is not in review status", async () => {
    // Override the mock to return a non-review epic
    const { db } = await import("@/lib/db");
    const originalGet = (db.get as ReturnType<typeof vi.fn>).getMockImplementation();
    (db.get as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ...mockEpic,
      status: "in_progress",
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/approve/route"
    );

    const req = mockNextRequest({ url: "http://localhost/api/test", method: "POST" });

    const res = await POST(req, mockRouteContext({ projectId: "p1", epicId: "epic-1" }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("review");

    // Restore
    if (originalGet) {
      (db.get as ReturnType<typeof vi.fn>).mockImplementation(originalGet);
    }
  });
});
