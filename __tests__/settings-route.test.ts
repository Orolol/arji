import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  allRows: [] as Array<{ key: string; value: string }>,
  getQueue: [] as Array<unknown>,
  insertCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    all: vi.fn(() => mockDbState.allRows),
    get: vi.fn(() => mockDbState.getQueue.shift() ?? null),
    insert: vi.fn().mockReturnValue({
      values: vi.fn((payload: Record<string, unknown>) => {
        mockDbState.insertCalls.push(payload);
        return { run: vi.fn() };
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    }),
  };

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  settings: {
    key: "key",
    value: "value",
    updatedAt: "updatedAt",
  },
}));

describe("Settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.allRows = [];
    mockDbState.getQueue = [];
    mockDbState.insertCalls = [];
  });

  it("GET redacts github_pat while preserving hasToken", async () => {
    mockDbState.allRows = [
      { key: "global_prompt", value: JSON.stringify("Always write tests") },
      { key: "github_pat", value: JSON.stringify("ghp_super_secret") },
    ];

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.global_prompt).toBe("Always write tests");
    expect(json.data.github_pat).toEqual({ hasToken: true });
    expect(JSON.stringify(json)).not.toContain("ghp_super_secret");
  });

  it("GET shows hasToken false when PAT is blank", async () => {
    mockDbState.allRows = [
      { key: "github_pat", value: JSON.stringify("") },
    ];

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const json = await res.json();

    expect(json.data.github_pat).toEqual({ hasToken: false });
  });

  it("PATCH rejects non-string github_pat values with actionable error", async () => {
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(
      {
        json: () => Promise.resolve({ github_pat: { token: "ghp_bad" } }),
      } as unknown as import("next/server").NextRequest
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("GitHub token must be saved as a string value.");
  });

  it("PATCH persists github_pat string value", async () => {
    mockDbState.getQueue = [null];
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(
      {
        json: () => Promise.resolve({ github_pat: "ghp_123" }),
      } as unknown as import("next/server").NextRequest
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.updated).toBe(true);
    expect(mockDbState.insertCalls).toContainEqual(
      expect.objectContaining({
        key: "github_pat",
        value: JSON.stringify("ghp_123"),
      })
    );
  });
});
