import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
  allQueue: [] as unknown[],
  insertCalls: [] as Array<{ table: unknown; payload: unknown }>,
}));

const mockIdState = vi.hoisted(() => ({ value: 1 }));
const mockTryExportArjiJson = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain: {
    select: ReturnType<typeof vi.fn>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    all: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
  } = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    insert: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.get.mockImplementation(() => mockDbState.getQueue.shift() ?? null);
  chain.all.mockImplementation(() => mockDbState.allQueue.shift() ?? []);
  chain.insert.mockImplementation((table: unknown) => ({
    values: vi.fn((payload: unknown) => {
      mockDbState.insertCalls.push({ table, payload });
      return { run: vi.fn() };
    }),
  }));

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  epics: mockSchema.epics,
  userStories: mockSchema.userStories,
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
    expect(storyInserts).toHaveLength(2);

    expect(storyInserts[0].payload).toEqual(
      expect.objectContaining({
        epicId: "id-1",
        position: 0,
      }),
    );
    expect(storyInserts[1].payload).toEqual(
      expect.objectContaining({
        epicId: "id-1",
        position: 1,
      }),
    );

    expect(mockTryExportArjiJson).toHaveBeenCalledWith("proj1");
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
});
