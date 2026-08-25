/**
 * Tests for named agents CRUD operations (lib/agent-config/named-agents.ts)
 * and agent resolution (lib/agent-config/agent-resolution.ts), against a real
 * in-memory sqlite database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

// Create test database before mock setup
const testSqlite = new Database(":memory:");
testSqlite.pragma("foreign_keys = ON");

testSqlite.exec(`
  CREATE TABLE named_agents (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    readable_agent_name TEXT,
    escalates_to TEXT REFERENCES named_agents(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX named_agents_name_unique ON named_agents (name);
  CREATE UNIQUE INDEX named_agents_readable_agent_name_unique ON named_agents (readable_agent_name);

  CREATE TABLE agent_provider_defaults (
    id TEXT PRIMARY KEY NOT NULL,
    agent_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    named_agent_id TEXT REFERENCES named_agents(id) ON DELETE SET NULL,
    scope TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE UNIQUE INDEX agent_provider_defaults_agent_type_scope_unique
    ON agent_provider_defaults (agent_type, scope);
`);

vi.mock("@/lib/db", () => {
  return {
    db: testDb,
    sqlite: testSqlite,
  };
});

// Must create drizzle instance before mock
import * as schema from "@/lib/db/schema";
const testDb = drizzle(testSqlite, { schema });

let counter = 0;
vi.mock("@/lib/utils/nanoid", () => ({
  createId: () => `test-id-${++counter}`,
}));

beforeEach(() => {
  testSqlite.exec("DELETE FROM agent_provider_defaults");
  testSqlite.exec("DELETE FROM named_agents");
  counter = 0;
});

describe("listNamedAgents", () => {
  it("returns empty array when no agents exist", async () => {
    const { listNamedAgents } = await import("@/lib/agent-config/named-agents");
    const agents = await listNamedAgents();
    expect(agents).toEqual([]);
  });

  it("returns agents ordered by name", async () => {
    const { listNamedAgents, createNamedAgent } = await import("@/lib/agent-config/named-agents");
    await createNamedAgent({ name: "Zebra Agent", provider: "codex", model: "gpt-5" });
    await createNamedAgent({ name: "Alpha Agent", provider: "claude-code", model: "opus" });

    const agents = await listNamedAgents();
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe("Alpha Agent");
    expect(agents[1].name).toBe("Zebra Agent");
  });
});

describe("getNamedAgent", () => {
  it("returns the agent when found", async () => {
    const { createNamedAgent, getNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data: created } = await createNamedAgent({
      name: "Lookup Agent",
      provider: "claude-code",
      model: "opus",
    });

    const found = await getNamedAgent(created!.id);
    expect(found).toMatchObject({
      id: created!.id,
      name: "Lookup Agent",
      provider: "claude-code",
      model: "opus",
    });
  });

  it("returns null when not found", async () => {
    const { getNamedAgent } = await import("@/lib/agent-config/named-agents");
    expect(await getNamedAgent("nonexistent")).toBeNull();
  });
});

describe("createNamedAgent", () => {
  it("creates a named agent with valid input", async () => {
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data, error } = await createNamedAgent({
      name: "CC Opus",
      provider: "claude-code",
      model: "claude-opus-4-6",
    });

    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(data!.name).toBe("CC Opus");
    expect(data!.provider).toBe("claude-code");
    expect(data!.model).toBe("claude-opus-4-6");
  });

  it("validates name uniqueness", async () => {
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");
    await createNamedAgent({ name: "Agent1", provider: "claude-code", model: "sonnet" });
    const { data, error } = await createNamedAgent({ name: "Agent1", provider: "codex", model: "gpt-5" });

    expect(data).toBeNull();
    expect(error).toContain("already exists");
  });

  it("validates empty name", async () => {
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data, error } = await createNamedAgent({ name: "  ", provider: "claude-code", model: "sonnet" });
    expect(data).toBeNull();
    expect(error).toContain("Name must not be empty");
  });

  it("validates invalid provider", async () => {
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data, error } = await createNamedAgent({ name: "Test", provider: "invalid", model: "x" });
    expect(data).toBeNull();
    expect(error).toContain("Invalid provider");
  });

  it("defaults to CLI default model when empty", async () => {
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data, error } = await createNamedAgent({ name: "Test", provider: "claude-code", model: "  " });
    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(data!.model).toBe("");
  });

  it("defaults to CLI default model when model is omitted", async () => {
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data, error } = await createNamedAgent({ name: "NoModel", provider: "codex" });
    expect(error).toBeUndefined();
    expect(data).toBeDefined();
    expect(data!.model).toBe("");
  });

  it("accepts gemini-cli as provider", async () => {
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data, error } = await createNamedAgent({
      name: "Gemini Flash",
      provider: "gemini-cli",
      model: "gemini-2.0-flash",
    });
    expect(error).toBeUndefined();
    expect(data!.provider).toBe("gemini-cli");
    expect(data!.model).toBe("gemini-2.0-flash");
  });
});

describe("updateNamedAgent", () => {
  it("updates specified fields only", async () => {
    const { createNamedAgent, updateNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data: created } = await createNamedAgent({ name: "Agent", provider: "claude-code", model: "opus" });

    const { data: updated } = await updateNamedAgent(created!.id, { model: "sonnet" });
    expect(updated!.model).toBe("sonnet");
    expect(updated!.name).toBe("Agent");
    expect(updated!.provider).toBe("claude-code");
  });

  it("returns error for non-existent agent", async () => {
    const { updateNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { data, error } = await updateNamedAgent("nonexistent", { name: "X" });
    expect(data).toBeNull();
    expect(error).toContain("not found");
  });

  it("validates duplicate name on update", async () => {
    const { createNamedAgent, updateNamedAgent } = await import("@/lib/agent-config/named-agents");
    await createNamedAgent({ name: "Agent1", provider: "claude-code", model: "opus" });
    const { data: agent2 } = await createNamedAgent({ name: "Agent2", provider: "codex", model: "gpt-5" });

    const { data, error } = await updateNamedAgent(agent2!.id, { name: "Agent1" });
    expect(data).toBeNull();
    expect(error).toContain("already exists");
  });

  it("configures a same-provider escalation target", async () => {
    const { createNamedAgent, updateNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { data: stronger } = await createNamedAgent({
      name: "Stronger",
      provider: "claude-code",
      model: "opus",
    });
    const { data: base } = await createNamedAgent({
      name: "Base",
      provider: "claude-code",
      model: "sonnet",
    });

    const { data, error } = await updateNamedAgent(base!.id, {
      escalatesTo: stronger!.id,
    });

    expect(error).toBeUndefined();
    expect(data?.escalatesTo).toBe(stronger!.id);
  });

  it("rejects direct and transitive escalation cycles", async () => {
    const { createNamedAgent, updateNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { data: first } = await createNamedAgent({
      name: "First",
      provider: "codex",
      model: "gpt-5-mini",
    });
    const { data: second } = await createNamedAgent({
      name: "Second",
      provider: "codex",
      model: "gpt-5",
    });
    const { data: third } = await createNamedAgent({
      name: "Third",
      provider: "codex",
      model: "gpt-5-pro",
    });

    expect(
      (await updateNamedAgent(first!.id, { escalatesTo: first!.id })).error
    ).toContain("cycle");
    expect(
      (await updateNamedAgent(first!.id, { escalatesTo: second!.id })).data
    ).not.toBeNull();
    expect(
      (await updateNamedAgent(second!.id, { escalatesTo: third!.id })).data
    ).not.toBeNull();

    const rejected = await updateNamedAgent(third!.id, {
      escalatesTo: first!.id,
    });
    expect(rejected.data).toBeNull();
    expect(rejected.error).toContain("cycle");
    expect((await updateNamedAgent(third!.id, {})).data?.escalatesTo).toBeNull();
  });

  it("rejects escalation edges across providers", async () => {
    const { createNamedAgent, updateNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { data: claude } = await createNamedAgent({
      name: "Claude",
      provider: "claude-code",
    });
    const { data: codex } = await createNamedAgent({
      name: "Codex",
      provider: "codex",
    });

    const rejected = await updateNamedAgent(claude!.id, {
      escalatesTo: codex!.id,
    });
    expect(rejected.data).toBeNull();
    expect(rejected.error).toContain("same provider");
  });
});

describe("deleteNamedAgent", () => {
  it("deletes an existing agent", async () => {
    const { createNamedAgent, deleteNamedAgent, listNamedAgents } = await import("@/lib/agent-config/named-agents");
    const { data: created } = await createNamedAgent({ name: "Agent", provider: "claude-code", model: "opus" });

    const deleted = await deleteNamedAgent(created!.id);
    expect(deleted).toBe(true);

    const agents = await listNamedAgents();
    expect(agents).toHaveLength(0);
  });

  it("returns false for non-existent agent", async () => {
    const { deleteNamedAgent } = await import("@/lib/agent-config/named-agents");
    const deleted = await deleteNamedAgent("nonexistent");
    expect(deleted).toBe(false);
  });

  it("nullifies referencing agentProviderDefaults rows", async () => {
    const { createNamedAgent, deleteNamedAgent } = await import("@/lib/agent-config/named-agents");
    const { eq } = await import("drizzle-orm");

    const { data: agent } = await createNamedAgent({ name: "Agent", provider: "claude-code", model: "opus" });

    // Create a provider default referencing this agent
    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "default-1",
        agentType: "build",
        provider: "claude-code",
        namedAgentId: agent!.id,
        scope: "global",
      })
      .run();

    await deleteNamedAgent(agent!.id);

    const row = testDb
      .select()
      .from(schema.agentProviderDefaults)
      .where(eq(schema.agentProviderDefaults.id, "default-1"))
      .get();

    expect(row?.namedAgentId).toBeNull();
  });

  it("nullifies an escalation edge when its target is deleted", async () => {
    const { createNamedAgent, deleteNamedAgent, updateNamedAgent } = await import(
      "@/lib/agent-config/named-agents"
    );
    const { data: target } = await createNamedAgent({
      name: "Target",
      provider: "claude-code",
      model: "opus",
    });
    const { data: source } = await createNamedAgent({
      name: "Source",
      provider: "claude-code",
      model: "sonnet",
    });
    await updateNamedAgent(source!.id, { escalatesTo: target!.id });

    await deleteNamedAgent(target!.id);

    expect((await updateNamedAgent(source!.id, {})).data?.escalatesTo).toBeNull();
  });
});

describe("resolveAgent", () => {
  it("preserves the historical lightweight defaults when no task mapping exists", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");

    expect(resolveAgent("title_generation", "project-123")).toEqual({
      provider: "claude-code",
      model: "haiku",
      namedAgentId: null,
    });
    expect(resolveAgent("import_analysis", "project-123")).toEqual({
      provider: "claude-code",
      namedAgentId: null,
    });
  });

  it("returns fallback when no defaults configured", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const result = await resolveAgent("build");
    expect(result.provider).toBe("claude-code");
    expect(result.namedAgentId).toBeNull();
  });

  it("resolves named agent when namedAgentId is set", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");

    const { data: agent } = await createNamedAgent({
      name: "CC Opus",
      provider: "claude-code",
      model: "claude-opus-4-6",
    });

    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "default-1",
        agentType: "build",
        provider: "claude-code",
        namedAgentId: agent!.id,
        scope: "global",
      })
      .run();

    const result = await resolveAgent("build");
    expect(result.provider).toBe("claude-code");
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.name).toBe("CC Opus");
  });

  it("ignores a legacy raw provider when namedAgentId is null", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");

    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "default-1",
        agentType: "build",
        provider: "codex",
        scope: "global",
      })
      .run();

    const result = await resolveAgent("build");
    expect(result.provider).toBe("claude-code");
    expect(result.model).toBeUndefined();
    expect(result.name).toBeUndefined();
  });

  it("project scope overrides global scope", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");

    const { data: globalAgent } = await createNamedAgent({
      name: "Global Agent",
      provider: "claude-code",
      model: "sonnet",
    });
    const { data: projectAgent } = await createNamedAgent({
      name: "Project Agent",
      provider: "gemini-cli",
      model: "gemini-2.0-flash",
    });

    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "default-global",
        agentType: "build",
        provider: "claude-code",
        namedAgentId: globalAgent!.id,
        scope: "global",
      })
      .run();

    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "default-project",
        agentType: "build",
        provider: "gemini-cli",
        namedAgentId: projectAgent!.id,
        scope: "project-123",
      })
      .run();

    const result = await resolveAgent("build", "project-123");
    expect(result.provider).toBe("gemini-cli");
    expect(result.model).toBe("gemini-2.0-flash");
    expect(result.name).toBe("Project Agent");
  });

  it("falls back to global when no project override", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");

    const { data: globalAgent } = await createNamedAgent({
      name: "Global Agent",
      provider: "codex",
      model: "gpt-5",
    });

    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "default-global",
        agentType: "build",
        provider: "codex",
        namedAgentId: globalAgent!.id,
        scope: "global",
      })
      .run();

    const result = await resolveAgent("build", "project-123");
    expect(result.provider).toBe("codex");
    expect(result.model).toBe("gpt-5");
    expect(result.name).toBe("Global Agent");
  });

  it("resolves an agentType mapping through project, global, then builtin", async () => {
    const { resolveAgent } = await import("@/lib/agent-config/agent-resolution");
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");

    const { data: globalAgent } = await createNamedAgent({
      name: "Global Lightweight",
      provider: "codex",
      model: "gpt-5-mini",
    });
    const { data: projectAgent } = await createNamedAgent({
      name: "Project Lightweight",
      provider: "gemini-cli",
      model: "gemini-flash",
    });

    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "title-global",
        agentType: "title_generation",
        provider: globalAgent!.provider,
        namedAgentId: globalAgent!.id,
        scope: "global",
      })
      .run();
    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "title-project",
        agentType: "title_generation",
        provider: projectAgent!.provider,
        namedAgentId: projectAgent!.id,
        scope: "project-123",
      })
      .run();

    expect(resolveAgent("title_generation", "project-123")).toMatchObject({
      provider: "gemini-cli",
      model: "gemini-flash",
      namedAgentId: projectAgent!.id,
    });
    expect(resolveAgent("title_generation", "another-project")).toMatchObject({
      provider: "codex",
      model: "gpt-5-mini",
      namedAgentId: globalAgent!.id,
    });
    expect(resolveAgent("import_analysis", "project-123")).toEqual({
      provider: "claude-code",
      namedAgentId: null,
    });
  });

  it("keeps an explicit UI agent choice ahead of the agentType mapping", async () => {
    const { resolveAgentByNamedId } = await import(
      "@/lib/agent-config/agent-resolution"
    );
    const { createNamedAgent } = await import("@/lib/agent-config/named-agents");

    const { data: mappedAgent } = await createNamedAgent({
      name: "Mapped Lightweight",
      provider: "gemini-cli",
      model: "gemini-flash",
    });
    const { data: explicitAgent } = await createNamedAgent({
      name: "Explicit Choice",
      provider: "codex",
      model: "gpt-5",
    });
    testDb.insert(schema.agentProviderDefaults)
      .values({
        id: "distill-project",
        agentType: "memory_distill",
        provider: mappedAgent!.provider,
        namedAgentId: mappedAgent!.id,
        scope: "project-123",
      })
      .run();

    expect(
      resolveAgentByNamedId(
        "memory_distill",
        "project-123",
        explicitAgent!.id
      )
    ).toMatchObject({
      provider: "codex",
      model: "gpt-5",
      namedAgentId: explicitAgent!.id,
    });
  });
});
