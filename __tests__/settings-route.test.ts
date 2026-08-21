import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  resetDbMockState,
  mockJsonRequest,
} from "@/__tests__/helpers/db-mock";
import {
  PROJECTS_ROOT_SETTING_KEY,
  parseProjectsRootSetting,
} from "@/lib/projects/workspace-constants";

// Real drizzle-orm + real @/lib/db/schema; the shared chain mock ignores
// column identity, so no fake column maps.
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

describe("Settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("GET redacts github_pat while preserving hasToken", async () => {
    dbMockState.allRows = [
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
    dbMockState.allRows = [
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
      mockJsonRequest({ github_pat: { token: "ghp_bad" } })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("GitHub token must be saved as a string value.");
  });

  it("PATCH persists github_pat string value", async () => {
    dbMockState.getQueue = [null];
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(
      mockJsonRequest({ github_pat: "ghp_123" })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.updated).toBe(true);
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        key: "github_pat",
        value: JSON.stringify("ghp_123"),
      })
    );
  });

  it("GET exposes the resolved default projects root the client cannot compute", async () => {
    dbMockState.allRows = [];

    const { GET } = await import("@/app/api/settings/route");
    const json = await (await GET()).json();

    expect(json.defaults.projects_root).toBe(
      path.join(process.cwd(), "projects")
    );
    // Never mixed into `data`: a round-trip would write the default back as a
    // stored override.
    expect(json.data.projects_root).toBeUndefined();
  });

  it("PATCH rejects a non-string projects_root", async () => {
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(mockJsonRequest({ projects_root: { path: "/srv" } }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Projects directory must be saved as a string value.");
    expect(dbMockState.insertCalls).toHaveLength(0);
  });
  it("PATCH rejects mixed valid/invalid payload without persisting any key", async () => {
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(
      mockJsonRequest({
        global_prompt: "changed",
        projects_root: 42,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Projects directory must be saved as a string value.");
    expect(dbMockState.insertCalls).toHaveLength(0);
    expect(dbMockState.updateCalls).toHaveLength(0);
  });

  it("PATCH rejects an array payload with 400", async () => {
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(mockJsonRequest(["not", "an", "object"]));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("Invalid settings payload");
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("PATCH persists a projects_root override", async () => {
    dbMockState.getQueue = [null];
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(mockJsonRequest({ projects_root: "/srv/clones" }));

    expect(res.status).toBe(200);
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        key: PROJECTS_ROOT_SETTING_KEY,
        value: JSON.stringify("/srv/clones"),
      })
    );
  });

  it("PATCH accepts a blank projects_root, which clears the override", async () => {
    dbMockState.getQueue = [{ key: PROJECTS_ROOT_SETTING_KEY, value: '"/srv/clones"' }];
    const { PATCH } = await import("@/app/api/settings/route");

    const res = await PATCH(mockJsonRequest({ projects_root: "" }));

    expect(res.status).toBe(200);
    expect(dbMockState.updateCalls).toContainEqual(
      expect.objectContaining({ value: JSON.stringify("") })
    );
    // A stored "" parses back to "no override" -> the default root.
    expect(parseProjectsRootSetting("")).toBeNull();
  });

  it("GET masks openai_api_key as hasToken without leaking the key", async () => {
    dbMockState.allRows = [
      { key: "openai_base_url", value: JSON.stringify("http://localhost:11434/v1") },
      { key: "openai_api_key", value: JSON.stringify("sk-super-secret") },
      { key: "openai_model", value: JSON.stringify("gpt-4o-mini") },
      { key: "openai_reasoning_effort", value: JSON.stringify("medium") },
    ];

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.openai_api_key).toEqual({ hasToken: true });
    expect(json.data.openai_base_url).toBe("http://localhost:11434/v1");
    expect(json.data.openai_model).toBe("gpt-4o-mini");
    expect(json.data.openai_reasoning_effort).toBe("medium");
    expect(JSON.stringify(json)).not.toContain("sk-super-secret");
  });

  it("GET reports hasToken false when the OpenAI key is empty", async () => {
    dbMockState.allRows = [
      { key: "openai_api_key", value: JSON.stringify("") },
    ];

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const json = await res.json();

    expect(json.data.openai_api_key).toEqual({ hasToken: false });
  });

  it("PATCH persists an openai_api_key string value", async () => {
    dbMockState.getQueue = [null]; // no existing row -> insert path

    const { PATCH } = await import("@/app/api/settings/route");
    const res = await PATCH(mockJsonRequest({ openai_api_key: "sk-123" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.updated).toBe(true);
    expect(dbMockState.insertCalls).toContainEqual(
      expect.objectContaining({
        key: "openai_api_key",
        value: JSON.stringify("sk-123"),
      })
    );
  });

  it("PATCH rejects non-string openai_api_key values", async () => {
    const { PATCH } = await import("@/app/api/settings/route");
    const res = await PATCH(
      mockJsonRequest({ openai_api_key: { token: "sk-bad" } })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("OpenAI API key must be saved as a string value.");
  });
});
