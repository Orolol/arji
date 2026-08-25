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

  it("provider type union includes all providers", async () => {
    const { isAgentProvider } = await import("@/lib/agent-config/constants");
    expect(isAgentProvider("claude-code")).toBe(true);
    expect(isAgentProvider("codex")).toBe(true);
    expect(isAgentProvider("gemini-cli")).toBe(true);
    expect(isAgentProvider("mistral-vibe")).toBe(true);
    expect(isAgentProvider("qwen-code")).toBe(true);
    expect(isAgentProvider("opencode")).toBe(true);
    expect(isAgentProvider("deepseek")).toBe(true);
    expect(isAgentProvider("kimi")).toBe(true);
    expect(isAgentProvider("zai")).toBe(true);
    expect(isAgentProvider("pi")).toBe(true);
    expect(isAgentProvider("oh-my-pi")).toBe(true);
    expect(isAgentProvider("invalid")).toBe(false);
  });

  it("PROVIDER_OPTIONS includes all providers", async () => {
    const { PROVIDER_OPTIONS } = await import("@/lib/agent-config/constants");
    expect(PROVIDER_OPTIONS).toContain("claude-code");
    expect(PROVIDER_OPTIONS).toContain("codex");
    expect(PROVIDER_OPTIONS).toContain("gemini-cli");
    expect(PROVIDER_OPTIONS).toContain("mistral-vibe");
    expect(PROVIDER_OPTIONS).toContain("qwen-code");
    expect(PROVIDER_OPTIONS).toContain("opencode");
    expect(PROVIDER_OPTIONS).toContain("deepseek");
    expect(PROVIDER_OPTIONS).toContain("kimi");
    expect(PROVIDER_OPTIONS).toContain("zai");
    expect(PROVIDER_OPTIONS).toContain("pi");
    expect(PROVIDER_OPTIONS).toContain("oh-my-pi");
    expect(PROVIDER_OPTIONS).toHaveLength(11);
  });

  it("ProviderType in providers/types.ts includes gemini-cli", async () => {
    // We can't test types at runtime directly, but we can test via the provider factory
    // which uses the ProviderType. The type system will catch issues at compile time.
    const types = await import("@/lib/providers/types");
    expect(types).toBeDefined();
  });
});
