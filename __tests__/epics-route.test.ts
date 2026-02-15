import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

const mockSql = vi.hoisted(() =>
  vi.fn(() => ({
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
  userStories: mockSchema.userStories,
  ticketComments: mockSchema.ticketComments,
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

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

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
      { params: Promise.resolve({ projectId: "proj1" }) },
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
        },
      ],
    ];

    const { GET } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await GET({} as never, {
      params: Promise.resolve({ projectId: "proj1" }),
    });

    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data[0]).toMatchObject({
      id: "epic-1",
      usCount: 2,
      usDone: 1,
      latestCommentId: "comment-2",
    });
    expect((db as unknown as { leftJoin: ReturnType<typeof vi.fn> }).leftJoin).toHaveBeenCalledTimes(2);
    expect((db as unknown as { groupBy: ReturnType<typeof vi.fn> }).groupBy).toHaveBeenCalledTimes(1);

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
      { params: Promise.resolve({ projectId: "proj1" }) },
    );

    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.error).toBe("Title is required");
  });

  it("rolls back epic creation when story insert fails inside transaction", async () => {
    mockDbState.getQueue = [{ max: 0 }];
    mockDbState.failOnStoryInsert = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("@/app/api/projects/[projectId]/epics/route");
    const response = await POST(
      mockRequest({
        title: "Transactional Epic",
        userStories: [{ title: "As a user, I want safety so that failures rollback" }],
      }),
      { params: Promise.resolve({ projectId: "proj1" }) },
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
