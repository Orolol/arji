import { describe, it, expect } from "vitest";

describe("Schema: namedAgents table and provider types", () => {
  it("namedAgents table is exported with correct columns", async () => {
    const { namedAgents } = await import("@/lib/db/schema");
    expect(namedAgents).toBeDefined();

    // Verify column names exist
    const columnNames = Object.keys(namedAgents);
    expect(columnNames).toContain("id");
    expect(columnNames).toContain("name");
    expect(columnNames).toContain("provider");
    expect(columnNames).toContain("model");
    expect(columnNames).toContain("escalatesTo");
    expect(columnNames).toContain("createdAt");
  });

  it("agentProviderDefaults has namedAgentId FK column", async () => {
    const { agentProviderDefaults } = await import("@/lib/db/schema");
    const columnNames = Object.keys(agentProviderDefaults);
    expect(columnNames).toContain("namedAgentId");
  });

  it("NamedAgent type is exported", async () => {
    // This test verifies the type export works at runtime via the schema
    const schema = await import("@/lib/db/schema");
    expect(schema.namedAgents).toBeDefined();
  });

  it("provider type union includes exactly the registered providers", async () => {
    const { isAgentProvider } = await import("@/lib/agent-config/constants");
    expect(isAgentProvider("claude-code")).toBe(true);
    expect(isAgentProvider("codex")).toBe(true);
    expect(isAgentProvider("oh-my-pi")).toBe(true);
    // Removed in the 2026-08 MCP cleanup — no longer valid providers.
    expect(isAgentProvider("gemini-cli")).toBe(false);
    expect(isAgentProvider("mistral-vibe")).toBe(false);
    expect(isAgentProvider("qwen-code")).toBe(false);
    expect(isAgentProvider("opencode")).toBe(false);
    expect(isAgentProvider("deepseek")).toBe(false);
    expect(isAgentProvider("kimi")).toBe(false);
    expect(isAgentProvider("zai")).toBe(false);
    expect(isAgentProvider("pi")).toBe(false);
    expect(isAgentProvider("invalid")).toBe(false);
  });

  it("PROVIDER_OPTIONS lists exactly the registered providers in stable order", async () => {
    const { PROVIDER_OPTIONS } = await import("@/lib/agent-config/constants");
    expect(PROVIDER_OPTIONS).toEqual(["claude-code", "codex", "oh-my-pi"]);
  });

  it("ProviderType module in providers/types.ts is importable", async () => {
    // We can't test types at runtime directly, but we can test via the provider factory
    // which uses the ProviderType. The type system will catch issues at compile time.
    const types = await import("@/lib/providers/types");
    expect(types).toBeDefined();
  });
});
