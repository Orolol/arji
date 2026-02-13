import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbState = vi.hoisted(() => ({
  allQueue: [] as unknown[],
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
  sql: vi.fn(() => ({})),
}));

vi.mock("@/lib/db", () => {
  const chain = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    get: vi.fn(),
    all: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
    insert: vi.fn(),
  };

  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.all.mockImplementation(() => mockDbState.allQueue.shift() ?? []);
  chain.get.mockReturnValue(null);
  chain.update.mockReturnValue(chain);
  chain.set.mockReturnValue(chain);
  chain.insert.mockReturnValue({
    values: vi.fn(() => ({ run: vi.fn() })),
  });

  return { db: chain };
});

vi.mock("@/lib/db/schema", () => ({
  settings: {
    __name: "settings",
    key: "key",
    value: "value",
    updatedAt: "updatedAt",
  },
}));

describe("GET /api/settings - GitHub PAT redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbState.allQueue = [];
  });

  it("redacts github_pat value, keeping prefix and last 4 chars", async () => {
    mockDbState.allQueue = [
      [
        {
          key: "github_pat",
          value: JSON.stringify("ghp_abcdefghijklmnopqrstuvwxyz1234"),
        },
        { key: "global_prompt", value: JSON.stringify("Hello world") },
      ],
    ];

    const { GET } = await import("@/app/api/settings/route");
    const response = await GET();
    const json = await response.json();

    expect(json.data.github_pat).not.toBe("ghp_abcdefghijklmnopqrstuvwxyz1234");
    expect(json.data.github_pat).toMatch(/^ghp_\*+1234$/);
    // Ensure the raw token is not present
    expect(json.data.github_pat).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("does not touch other settings", async () => {
    mockDbState.allQueue = [
      [
        {
          key: "global_prompt",
          value: JSON.stringify("My custom prompt"),
        },
      ],
    ];

    const { GET } = await import("@/app/api/settings/route");
    const response = await GET();
    const json = await response.json();

    expect(json.data.global_prompt).toBe("My custom prompt");
  });

  it("handles short tokens gracefully", async () => {
    mockDbState.allQueue = [
      [
        {
          key: "github_pat",
          value: JSON.stringify("short"),
        },
      ],
    ];

    const { GET } = await import("@/app/api/settings/route");
    const response = await GET();
    const json = await response.json();

    // Short tokens get fully masked
    expect(json.data.github_pat).toBe("****");
  });
});
