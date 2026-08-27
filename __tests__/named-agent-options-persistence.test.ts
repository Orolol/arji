/**
 * Persisting per-CLI options and the persona on a named agent, against a real
 * in-memory sqlite database.
 *
 * The interesting rules are the ones a UI-only implementation would get
 * wrong: the server drops options the agent's CLI does not declare (so
 * switching CLI cannot leave ghost values behind), it refuses an out-of-range
 * value with a message the editor can show, and a persona is optional in a
 * way that distinguishes "not supplied" (use the product default) from
 * "explicitly empty" (inject nothing).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

const testSqlite = new Database(":memory:");
testSqlite.pragma("foreign_keys = ON");

testSqlite.exec(`
  CREATE TABLE named_agents (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    readable_agent_name TEXT,
    options TEXT NOT NULL DEFAULT '{}',
    persona_prompt TEXT,
    escalates_to TEXT REFERENCES named_agents(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX named_agents_name_unique ON named_agents (name);
`);

vi.mock("@/lib/db", () => ({ db: testDb, sqlite: testSqlite }));

import * as schema from "@/lib/db/schema";
const testDb = drizzle(testSqlite, { schema });

let counter = 0;
vi.mock("@/lib/utils/nanoid", () => ({
  createId: () => `agent-${++counter}`,
}));

import { DEFAULT_PERSONA_PROMPT } from "@/lib/agent-config/constants";

// Dynamic: the module reads `db` at import time, and the mock factory above
// cannot close over `testDb` until this file's top level has run.
type NamedAgentsModule = typeof import("@/lib/agent-config/named-agents");
const service = (): Promise<NamedAgentsModule> =>
  import("@/lib/agent-config/named-agents");

const createNamedAgent: NamedAgentsModule["createNamedAgent"] = async (input) =>
  (await service()).createNamedAgent(input);
const updateNamedAgent: NamedAgentsModule["updateNamedAgent"] = async (
  id,
  updates,
) => (await service()).updateNamedAgent(id, updates);
const getNamedAgent: NamedAgentsModule["getNamedAgent"] = async (id) =>
  (await service()).getNamedAgent(id);
async function runtimeConfig(
  agentId: string | null,
  provider: string,
): Promise<{ options: Record<string, unknown>; personaPrompt: string | null }> {
  return (await service()).getNamedAgentRuntimeConfig(agentId, provider);
}

beforeEach(() => {
  testSqlite.exec("DELETE FROM named_agents");
  counter = 0;
});

describe("createNamedAgent", () => {
  it("stores validated options and defaults the persona", async () => {
    const { data, error } = await createNamedAgent({
      name: "Codex High",
      provider: "codex",
      options: { reasoning_effort: "high" },
    });

    expect(error).toBeUndefined();
    expect(data?.options).toEqual({ reasoning_effort: "high" });
    expect(data?.personaPrompt).toBe(DEFAULT_PERSONA_PROMPT);
  });

  it("creates an option-free agent when none are supplied", async () => {
    const { data } = await createNamedAgent({
      name: "Plain",
      provider: "oh-my-pi",
    });
    expect(data?.options).toEqual({});
  });

  it("distinguishes an absent persona from an explicitly empty one", async () => {
    const explicit = await createNamedAgent({
      name: "No persona",
      provider: "claude-code",
      personaPrompt: "",
    });
    expect(explicit.data?.personaPrompt).toBeNull();

    const whitespace = await createNamedAgent({
      name: "Whitespace persona",
      provider: "claude-code",
      personaPrompt: "   \n  ",
    });
    expect(whitespace.data?.personaPrompt).toBeNull();
  });

  it("rejects a value the CLI does not accept", async () => {
    const { data, error } = await createNamedAgent({
      name: "Bad",
      provider: "agy",
      options: { effort: "max" },
    });
    expect(data).toBeNull();
    expect(error).toContain("Reasoning effort");
  });

  it("ignores an option key that belongs to another CLI", async () => {
    const { data } = await createNamedAgent({
      name: "Mismatched",
      provider: "oh-my-pi",
      options: { reasoning_effort: "high", thinking: "low" },
    });
    expect(data?.options).toEqual({ thinking: "low" });
  });
});

describe("updateNamedAgent", () => {
  it("saves and clears options", async () => {
    const created = await createNamedAgent({
      name: "Omp",
      provider: "oh-my-pi",
      options: { thinking: "high" },
    });
    const id = created.data!.id;

    const updated = await updateNamedAgent(id, {
      options: { thinking: "max", advisor: true },
    });
    expect(updated.data?.options).toEqual({ thinking: "max", advisor: true });

    const cleared = await updateNamedAgent(id, { options: {} });
    expect(cleared.data?.options).toEqual({});
  });

  it("resets incompatible options when the CLI changes", async () => {
    // Server-side reset, not merely a UI convenience: the stored bag must not
    // keep values the new CLI would reject or that the editor can no longer
    // show.
    const created = await createNamedAgent({
      name: "Switcher",
      provider: "codex",
      options: { reasoning_effort: "high", profile: "fast" },
    });
    const id = created.data!.id;

    const switched = await updateNamedAgent(id, { provider: "oh-my-pi" });
    expect(switched.data?.provider).toBe("oh-my-pi");
    expect(switched.data?.options).toEqual({});

    const stored = testSqlite
      .prepare("SELECT options FROM named_agents WHERE id = ?")
      .get(id) as { options: string };
    expect(stored.options).toBe("{}");
  });

  it("keeps the options a CLI change leaves valid", async () => {
    // claude and agy both declare `effort`, but agy has no `xhigh`.
    const created = await createNamedAgent({
      name: "Effortful",
      provider: "claude-code",
      options: { effort: "high" },
    });
    const switched = await updateNamedAgent(created.data!.id, {
      provider: "agy",
    });
    expect(switched.data?.options).toEqual({ effort: "high" });

    const tooHigh = await createNamedAgent({
      name: "Too high",
      provider: "claude-code",
      options: { effort: "max" },
    });
    const dropped = await updateNamedAgent(tooHigh.data!.id, {
      provider: "agy",
    });
    expect(dropped.data?.options).toEqual({});
  });

  it("rejects an invalid value with an explicit message", async () => {
    const created = await createNamedAgent({
      name: "Limits",
      provider: "oh-my-pi",
    });
    const result = await updateNamedAgent(created.data!.id, {
      options: { max_time: 5 },
    });
    expect(result.data).toBeNull();
    expect(result.error).toContain("between 30 and 86400");
  });

  it("edits and clears the persona", async () => {
    const created = await createNamedAgent({
      name: "Persona",
      provider: "claude-code",
    });
    const id = created.data!.id;

    const edited = await updateNamedAgent(id, {
      personaPrompt: "  You are a meticulous reviewer  ",
    });
    expect(edited.data?.personaPrompt).toBe("You are a meticulous reviewer");

    const cleared = await updateNamedAgent(id, { personaPrompt: "" });
    expect(cleared.data?.personaPrompt).toBeNull();
  });

  it("leaves options and persona untouched by an unrelated edit", async () => {
    const created = await createNamedAgent({
      name: "Untouched",
      provider: "codex",
      options: { reasoning_effort: "low" },
      personaPrompt: "Persona stays",
    });
    const renamed = await updateNamedAgent(created.data!.id, {
      name: "Renamed",
    });
    expect(renamed.data?.options).toEqual({ reasoning_effort: "low" });
    expect(renamed.data?.personaPrompt).toBe("Persona stays");
  });
});

describe("getNamedAgentRuntimeConfig", () => {
  it("returns the agent's options and persona for its own provider", async () => {
    const created = await createNamedAgent({
      name: "Runtime",
      provider: "codex",
      options: { reasoning_effort: "xhigh" },
      personaPrompt: "You're an experienced developer",
    });

    expect(await runtimeConfig(created.data!.id, "codex")).toEqual({
      options: { reasoning_effort: "xhigh" },
      personaPrompt: "You're an experienced developer",
    });
  });

  it("drops the options when the session spawns on another CLI", async () => {
    // Handing codex flags to omp is a fatal argv error, not a warning; the
    // persona is prompt text and stays.
    const created = await createNamedAgent({
      name: "Crossed",
      provider: "codex",
      options: { reasoning_effort: "high" },
      personaPrompt: "Careful",
    });

    expect(await runtimeConfig(created.data!.id, "oh-my-pi")).toEqual({
      options: {},
      personaPrompt: "Careful",
    });
  });

  it("is empty for a missing or absent agent", async () => {
    expect(await runtimeConfig(null, "codex")).toEqual({
      options: {},
      personaPrompt: null,
    });
    expect(await runtimeConfig("nope", "codex")).toEqual({
      options: {},
      personaPrompt: null,
    });
  });

  it("reads what an agent created before the feature would look like", async () => {
    testSqlite
      .prepare(
        "INSERT INTO named_agents (id, name, provider, model) VALUES (?, ?, ?, ?)",
      )
      .run("legacy", "Legacy", "claude-code", "opus");

    expect(await runtimeConfig("legacy", "claude-code")).toEqual({
      options: {},
      personaPrompt: null,
    });
    expect((await getNamedAgent("legacy"))?.personaPrompt).toBeNull();
  });
});

describe("named-agent API routes", () => {
  it("rejects an option value the registry does not allow, with its message", async () => {
    const { mockJsonRequest, mockRouteContext } = await import(
      "@/__tests__/helpers/db-mock"
    );
    const { POST } = await import("@/app/api/agent-config/named-agents/route");

    const response = await POST(
      mockJsonRequest({
        name: "Rejected",
        provider: "agy",
        options: { effort: "max" },
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Reasoning effort");
    expect(
      testSqlite.prepare("SELECT COUNT(*) AS n FROM named_agents").get(),
    ).toEqual({ n: 0 });

    // And the same on the update path.
    const created = await createNamedAgent({
      name: "Updatable",
      provider: "oh-my-pi",
    });
    const { PUT } = await import(
      "@/app/api/agent-config/named-agents/[agentId]/route"
    );
    const updateResponse = await PUT(
      mockJsonRequest({ options: { max_time: 1 } }),
      mockRouteContext({ agentId: created.data!.id }),
    );
    expect(updateResponse.status).toBe(400);
    expect((await updateResponse.json()).error).toContain("between 30 and 86400");
  });

  it("round-trips options and persona through create and read", async () => {
    const { mockJsonRequest } = await import("@/__tests__/helpers/db-mock");
    const { POST, GET } = await import(
      "@/app/api/agent-config/named-agents/route"
    );

    const created = await POST(
      mockJsonRequest({
        name: "Round trip",
        provider: "codex",
        options: { reasoning_effort: "xhigh" },
        personaPrompt: "You are a careful reviewer",
      }),
    );
    expect(created.status).toBe(201);

    const listed = await (await GET()).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].options).toEqual({ reasoning_effort: "xhigh" });
    expect(listed.data[0].personaPrompt).toBe("You are a careful reviewer");
  });
});
