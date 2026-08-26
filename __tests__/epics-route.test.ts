import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  mockJsonRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

// Takes the tagged-template args so `mockSql.mock.calls` stays inspectable —
// the query-shape assertions below read the raw template strings.
const mockSql = vi.hoisted(() =>
  vi.fn((..._args: unknown[]) => ({
    as: vi.fn(() => ({})),
  }))
);
const mockCount = vi.hoisted(() =>
  vi.fn(() => ({
    as: vi.fn(() => ({})),
  }))
);

const mockSchema = vi.hoisted(() => ({
  epics: {
    __name: "epics",
    id: "id",
    projectId: "projectId",
    title: "title",
    description: "description",
    priority: "priority",
    status: "status",
    position: "position",
    branchName: "branchName",
    confidence: "confidence",
    evidence: "evidence",
    createdAt: "createdAt",
    updatedAt: "updatedAt",
    readableId: "readableId",
  },
  projects: {
    __name: "projects",
    id: "id",
    name: "name",
  },
  userStories: {
    __name: "userStories",
    id: "id",
    epicId: "epicId",
    title: "title",
    description: "description",
    acceptanceCriteria: "acceptanceCriteria",
    status: "status",
    position: "position",
    createdAt: "createdAt",
  },
  ticketComments: {
    __name: "ticketComments",
    id: "id",
    epicId: "epicId",
    author: "author",
    createdAt: "createdAt",
  },
  agentSessions: {
    __name: "agentSessions",
    id: "id",
    epicId: "epicId",
    outcome: "outcome",
    endedAt: "endedAt",
    completedAt: "completedAt",
    createdAt: "createdAt",
  },
  gradingReports: {
    __name: "gradingReports",
    id: "id",
    epicId: "epicId",
    gradings: "gradings",
    summary: "summary",
    createdAt: "createdAt",
  },
  ticketReadCursors: {
    __name: "ticketReadCursors",
    epicId: "epicId",
    lastReadAt: "lastReadAt",
    updatedAt: "updatedAt",
  },
  // Read by the route's unverifiable-review pass
  // (listUnverifiableReviewEpicIds): the mcp_tools_enabled toggle, then the
  // latest delivered review per epic and the rows it filed.
  settings: {
    __name: "settings",
    key: "key",
    value: "value",
  },
  reviewComments: {
    __name: "reviewComments",
    id: "id",
    epicId: "epicId",
    agentSessionId: "agentSessionId",
  },
}));

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  allQueue: [] as unknown[],
  insertCalls: [] as Array<{ table: unknown; payload: unknown }>,
  failOnStoryInsert: false,
}));

const mockIdState = vi.hoisted(() => ({ value: 1 }));
const mockTryExportArjiJson = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: mockSql,
  count: mockCount,
}));

vi.mock("@/lib/db", () => {
  const chain: {
    select: ReturnType<typeof vi.fn>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    leftJoin: ReturnType<typeof vi.fn>;
    as: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  } = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    groupBy: vi.fn(),
    leftJoin: vi.fn(),
    as: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.groupBy.mockReturnValue(chain);
  chain.leftJoin.mockReturnValue(chain);
  chain.as.mockReturnValue({});
  chain.get.mockImplementation(() => mockDbState.getQueue.shift() ?? null);
  chain.all.mockImplementation(() => mockDbState.allQueue.shift() ?? []);
  chain.insert.mockImplementation((table: unknown) => ({
    values: vi.fn((payload: unknown) => {
      mockDbState.insertCalls.push({ table, payload });
      return { run: vi.fn() };
    }),
  }));
  chain.transaction.mockImplementation((callback: (tx: { insert: ReturnType<typeof vi.fn> }) => unknown) => {
    const staged: Array<{ table: unknown; payload: unknown }> = [];
    const tx = {
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((payload: unknown) => ({
          run: vi.fn(() => {
            if (mockDbState.failOnStoryInsert && table === mockSchema.userStories) {
              throw new Error("story insert failed");
            }
            staged.push({ table, payload });
          }),
        })),
      })),
    };

    const result = callback(tx);
    mockDbState.insertCalls.push(...staged);
    return result;
  });

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  epics: mockSchema.epics,
  projects: mockSchema.projects,
  userStories: mockSchema.userStories,
  ticketComments: mockSchema.ticketComments,
  agentSessions: mockSchema.agentSessions,
  gradingReports: mockSchema.gradingReports,
  ticketReadCursors: mockSchema.ticketReadCursors,
  settings: mockSchema.settings,
  reviewComments: mockSchema.reviewComments,
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => {
    const id = `id-${mockIdState.value}`;
    mockIdState.value += 1;
    return id;
  }),
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: mockTryExportArjiJson,
}));

vi.mock("@/lib/db/readable-id", () => ({
  generateReadableId: vi.fn(() => "E-test-001"),
}));

const mockRequest = mockJsonRequest;

describe("POST /api/projects/[projectId]/epics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
    mockDbState.allQueue = [];
    mockDbState.insertCalls = [];
    mockDbState.failOnStoryInsert = false;
    mockIdState.value = 1;
  });

  it("creates an epic and related user stories in one request", async () => {
    mockDbState.getQueue = [
      { id: "proj1", name: "Test Project" },
      { max: 2 },
      {
        id: "id-1",
        projectId: "proj1",
        title: "Account Security",
        description: "Improve auth",
        status: "backlog",
      },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await POST(
      mockRequest({
        title: "Account Security",
        description: "Improve auth",
        userStories: [
          {
            title: "As a user, I want 2FA so that my account is secure",
            description: "Enable OTP login",
            acceptanceCriteria: "- [ ] 2FA toggle available",
          },
          {
            title: "As an admin, I want security alerts so that I can react quickly",
          },
        ],
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const json = await response.json();
    expect(response.status).toBe(201);
    expect(json.data.id).toBe("id-1");
    expect(json.data.userStoriesCreated).toBe(2);

    const epicInserts = mockDbState.insertCalls.filter((call) => call.table === mockSchema.epics);
    const storyInserts = mockDbState.insertCalls.filter((call) => call.table === mockSchema.userStories);
    expect(epicInserts).toHaveLength(1);
    expect(storyInserts).toHaveLength(1);
    const insertedStories = storyInserts[0].payload as Array<Record<string, unknown>>;
    expect(insertedStories).toHaveLength(2);

    expect(insertedStories[0]).toEqual(
      expect.objectContaining({
        epicId: "id-1",
        position: 0,
      }),
    );
    expect(insertedStories[1]).toEqual(
      expect.objectContaining({
        epicId: "id-1",
        position: 1,
      }),
    );
    expect((db as unknown as { transaction: ReturnType<typeof vi.fn> }).transaction).toHaveBeenCalledTimes(1);

    expect(mockTryExportArjiJson).toHaveBeenCalledWith("proj1");
  });

  it("lists epics with JOIN-based story counts and latest comment metadata", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    mockDbState.allQueue = [
      [
        {
          id: "epic-1",
          projectId: "proj1",
          title: "Account Security",
          usCount: 2,
          usDone: 1,
          latestCommentId: "comment-2",
          latestCommentAuthor: "agent",
          latestCommentCreatedAt: "2026-02-14T11:22:00.000Z",
          latestSessionOutcome: "asked_question",
          latestSessionEndedAt: "2026-02-14T11:20:00.000Z",
          latestUserCommentCreatedAt: "2026-02-14T10:00:00.000Z",
          lastReadAt: "2026-02-14T11:00:00.000Z",
          latestGradingEntries: JSON.stringify([
            {
              storyId: "story-1",
              criterion: "The card refreshes",
              status: "missed",
              evidence: "No SSE refresh exists.",
            },
          ]),
          gradingSummary: "One gap remains.",
        },
      ],
    ];

    const { GET } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await GET({} as never, mockRouteContext({ projectId: "proj1" }));

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "epic-1",
      usCount: 2,
      usDone: 1,
      latestCommentId: "comment-2",
      latestSessionOutcome: "asked_question",
      latestSessionEndedAt: "2026-02-14T11:20:00.000Z",
      latestUserCommentCreatedAt: "2026-02-14T10:00:00.000Z",
      lastReadAt: "2026-02-14T11:00:00.000Z",
      gradingStatus: "missed",
      gradingSummary: "One gap remains.",
      // The Review column's blocking flag ships with every row; this board
      // has no unverifiable review, so it reads false rather than absent.
      reviewUnverifiable: false,
    });
    // story counts + latest comments + latest sessions + latest user comments
    // + session costs + latest grading + ticket read cursors
    expect((db as unknown as { leftJoin: ReturnType<typeof vi.fn> }).leftJoin).toHaveBeenCalledTimes(7);
    // story counts + session costs + latest user comments
    expect((db as unknown as { groupBy: ReturnType<typeof vi.fn> }).groupBy).toHaveBeenCalledTimes(3);

    const sqlFragments = mockSql.mock.calls.map(([template]) =>
      Array.isArray(template) ? template.join(" ") : String(template),
    );
    expect(sqlFragments.some((fragment) => fragment.includes("ROW_NUMBER() OVER"))).toBe(true);
    expect(debugSpy).toHaveBeenCalledWith(
      "[epics/GET] query profile",
      expect.objectContaining({
        projectId: "proj1",
        rowCount: 1,
        queryMs: expect.any(Number),
      }),
    );
    debugSpy.mockRestore();
  });

  it("validates title input", async () => {
    const { POST } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await POST(
      mockRequest({
        description: "Missing title",
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error).toBe("Validation failed");
  });

  it("rejects a whitespace-only story title without persisting anything", async () => {
    // The route used to filter this story out and still answer 201, so the
    // caller was told two stories landed when only one did. Asserting the 400
    // alone would not catch a regression that inserts the epic first, hence the
    // zero-insert check.
    mockDbState.getQueue = [{ id: "proj1", name: "Test Project" }, { max: 0 }];

    const { POST } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await POST(
      mockRequest({
        title: "Account Security",
        userStories: [
          { title: "As a user, I want 2FA so that my account is secure" },
          { title: "   " },
        ],
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error).toBe("Validation failed");
    expect(mockDbState.insertCalls).toHaveLength(0);
    expect(mockTryExportArjiJson).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only epic title without persisting anything", async () => {
    mockDbState.getQueue = [{ id: "proj1", name: "Test Project" }, { max: 0 }];

    const { POST } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await POST(
      mockRequest({ title: "   " }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error).toBe("Validation failed");
    expect(mockDbState.insertCalls).toHaveLength(0);
  });

  it("persists epic and story titles trimmed", async () => {
    mockDbState.getQueue = [
      { id: "proj1", name: "Test Project" },
      { max: 0 },
      { id: "id-1", projectId: "proj1", title: "Account Security" },
    ];

    const { POST } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await POST(
      mockRequest({
        title: "  Account Security  ",
        description: "  Improve auth  ",
        userStories: [
          {
            title: "  As a user, I want 2FA so that my account is secure  ",
            description: "   ",
            acceptanceCriteria: "  - [ ] 2FA toggle available  ",
          },
        ],
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    expect(response.status).toBe(201);

    const epicInsert = mockDbState.insertCalls.find(
      (call) => call.table === mockSchema.epics,
    )?.payload as Record<string, unknown>;
    expect(epicInsert).toEqual(
      expect.objectContaining({
        title: "Account Security",
        description: "Improve auth",
      }),
    );

    const storyInsert = mockDbState.insertCalls.find(
      (call) => call.table === mockSchema.userStories,
    )?.payload as Array<Record<string, unknown>>;
    expect(storyInsert[0]).toEqual(
      expect.objectContaining({
        title: "As a user, I want 2FA so that my account is secure",
        // Blank prose is absence, not an empty string.
        description: null,
        acceptanceCriteria: "- [ ] 2FA toggle available",
      }),
    );
  });

  it("rolls back epic creation when story insert fails inside transaction", async () => {
    mockDbState.getQueue = [{ id: "proj1", name: "Test Project" }, { max: 0 }];
    mockDbState.failOnStoryInsert = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await POST(
      mockRequest({
        title: "Transactional Epic",
        userStories: [{ title: "As a user, I want safety so that failures rollback" }],
      }),
      mockRouteContext({ projectId: "proj1" }),
    );

    const json = await response.json();
    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to create epic");
    expect(mockDbState.insertCalls).toHaveLength(0);
    expect(mockTryExportArjiJson).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
