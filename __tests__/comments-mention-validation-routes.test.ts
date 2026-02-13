import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  getQueue: [] as unknown[],
}));

const mockValidateMentionsExist = vi.hoisted(() => vi.fn());

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    get: vi.fn(() => mockDbState.getQueue.shift() ?? null),
    all: vi.fn(() => []),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
  };

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  ticketComments: { id: "id", epicId: "epicId", userStoryId: "userStoryId", createdAt: "createdAt" },
  epics: { id: "id" },
  userStories: { id: "id" },
}));

vi.mock("@/lib/utils/nanoid", () => ({
  createId: vi.fn(() => "comment-1"),
}));

vi.mock("@/lib/documents/mentions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/documents/mentions")>(
    "@/lib/documents/mentions"
  );
  return {
    ...actual,
    validateMentionsExist: mockValidateMentionsExist,
  };
});

function mockRequest(body: Record<string, unknown>) {
  return {
    json: () => Promise.resolve(body),
  } as unknown as import("next/server").NextRequest;
}

describe("Comment mention validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.getQueue = [];
    mockValidateMentionsExist.mockImplementation(() => ({ mentions: [] }));
  });

  it("blocks epic comment submit when mention validation fails", async () => {
    const { MentionResolutionError } = await import("@/lib/documents/mentions");
    mockDbState.getQueue = [{ id: "epic-1" }];
    mockValidateMentionsExist.mockImplementation(() => {
      throw new MentionResolutionError(["missing.md"]);
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/epics/[epicId]/comments/route"
    );

    const res = await POST(
      mockRequest({ author: "user", content: "use @missing.md" }),
      { params: Promise.resolve({ projectId: "proj-1", epicId: "epic-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("Unknown document mention");
  });

  it("blocks story comment submit when mention validation fails", async () => {
    const { MentionResolutionError } = await import("@/lib/documents/mentions");
    mockDbState.getQueue = [{ id: "story-1" }];
    mockValidateMentionsExist.mockImplementation(() => {
      throw new MentionResolutionError(["missing.png"]);
    });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/stories/[storyId]/comments/route"
    );

    const res = await POST(
      mockRequest({ author: "user", content: "see @missing.png" }),
      { params: Promise.resolve({ projectId: "proj-1", storyId: "story-1" }) }
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("Unknown document mention");
  });
});
