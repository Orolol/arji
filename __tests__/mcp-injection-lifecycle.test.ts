/**
 * Arij MCP tool-channel injection — process-manager gating + token lifecycle.
 *
 * processManager.start() is the single wiring point: it mints the
 * per-session bearer token, attaches the MCP spawn config, and appends the
 * arijToolsSection prompt block — but ONLY when all three gates hold
 * (mcp_tools_enabled setting not explicitly false, provider supports MCP,
 * agent_sessions row exists). Completion, promise rejection, and cancel()
 * all revoke the session's tokens while KEEPING the store record (the
 * askedQuestion flag must survive until outcome classification).
 *
 * Mock style follows __tests__/process-manager.test.ts (hand-rolled hoisted
 * mocks — the shared db-mock helper is documented as incompatible with
 * vi.resetModules). The token store is deliberately REAL: it is
 * globalThis-backed, so records minted by the re-imported process-manager
 * generation are visible to this file's static import.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pmState = vi.hoisted(() => ({
  sessionRow: null as
    | null
    | {
        projectId: string;
        epicId: string | null;
        userStoryId: string | null;
        agentType: string | null;
      },
  settingsRow: null as null | { value: string },
  /** When true, any db.select() call throws — injection must degrade. */
  throwOnSelect: false,
  /** Tables whose select chain reached `.get()` — counts start()'s db reads. */
  selectGets: [] as unknown[],
  spawnedOptions: [] as Array<Record<string, unknown>>,
  providerSpawnedOptions: [] as Array<Record<string, unknown>>,
  resolveSpawn: null as null | ((r: unknown) => void),
  rejectSpawn: null as null | ((e: unknown) => void),
}));

const tables = vi.hoisted(() => ({
  agentSessions: {
    id: "agent_sessions.id",
    projectId: "agent_sessions.project_id",
    epicId: "agent_sessions.epic_id",
    userStoryId: "agent_sessions.user_story_id",
    agentType: "agent_sessions.agent_type",
  },
  settings: { key: "settings.key", value: "settings.value" },
  projects: { id: "projects.id", name: "projects.name" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

vi.mock("@/lib/db/schema", () => tables);

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => {
      if (pmState.throwOnSelect) {
        throw new Error("db exploded");
      }
      return {
        from: vi.fn((table: unknown) => ({
          where: vi.fn(() => ({
            get: vi.fn(() => {
              pmState.selectGets.push(table);
              return table === tables.settings
                ? pmState.settingsRow
                : pmState.sessionRow;
            }),
          })),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ run: vi.fn() })),
      })),
    })),
  },
}));

vi.mock("@/lib/agent-sessions/chunks", () => ({
  appendSessionChunk: vi.fn(),
}));

vi.mock("@/lib/claude/spawn", () => ({
  spawnClaude: vi.fn((options: Record<string, unknown>) => {
    pmState.spawnedOptions.push(options);
    return {
      promise: new Promise((resolve, reject) => {
        pmState.resolveSpawn = resolve;
        pmState.rejectSpawn = reject;
      }),
      kill: vi.fn(),
      command: "claude <prompt>",
    };
  }),
}));

vi.mock("@/lib/providers", () => ({
  getProvider: vi.fn((provider: string) => ({
    type: provider,
    spawn: vi.fn((options: Record<string, unknown>) => {
      pmState.providerSpawnedOptions.push(options);
      return {
        handle: `${provider}-test`,
        kill: vi.fn(),
        promise: new Promise(() => {
          /* stays pending — lifecycle driven per test */
        }),
        command: `${provider} <prompt>`,
      };
    }),
    cancel: vi.fn(() => true),
    isAvailable: vi.fn().mockResolvedValue(true),
  })),
}));

// REAL token store (globalThis-backed — shared across module generations).
import {
  resolveMcpToken,
  markQuestionAsked,
  _resetMcpTokenStoreForTests,
} from "@/lib/mcp/token-store";
import type { McpSpawnConfig } from "@/lib/providers/types";

let processManager: typeof import("@/lib/claude/process-manager").processManager;

function sessionRow(
  overrides: Partial<NonNullable<typeof pmState.sessionRow>> = {},
) {
  return {
    projectId: "proj-1",
    epicId: "epic-1",
    userStoryId: null,
    agentType: "build",
    ...overrides,
  };
}

function spawnedMcp(index = 0): McpSpawnConfig | undefined {
  return pmState.spawnedOptions[index]?.mcp as McpSpawnConfig | undefined;
}

async function flushPromises() {
  await new Promise((r) => setTimeout(r, 10));
}

async function resetAll() {
  vi.clearAllMocks();
  pmState.sessionRow = null;
  pmState.settingsRow = null;
  pmState.throwOnSelect = false;
  pmState.selectGets = [];
  pmState.spawnedOptions = [];
  pmState.providerSpawnedOptions = [];
  pmState.resolveSpawn = null;
  pmState.rejectSpawn = null;
  _resetMcpTokenStoreForTests();
  vi.resetModules();
  const mod = await import("@/lib/claude/process-manager");
  processManager = mod.processManager;
}

describe("processManager.start() — MCP injection gating", () => {
  beforeEach(resetAll);

  it("injects config + prompt section + resolvable token for claude-code (setting absent = on)", () => {
    pmState.sessionRow = sessionRow();

    processManager.start("s1", {
      mode: "code",
      prompt: "BASE PROMPT",
      allowedTools: ["Edit"],
    });

    const mcp = spawnedMcp();
    expect(mcp).toBeDefined();
    expect(mcp!.serverName).toBe("arij");
    expect(mcp!.command).toBe(process.execPath);
    expect(mcp!.args[0].endsWith("bin/arij-mcp.mjs")).toBe(true);
    expect(mcp!.env.ARIJ_MCP_TOKEN).toMatch(/^arij-mcp-/);
    expect(mcp!.allowedToolNames).toContain("mcp__arij__ask_question");

    const prompt = pmState.spawnedOptions[0].prompt as string;
    expect(prompt.startsWith("BASE PROMPT\n## Arij tools\n\n")).toBe(true);
    expect(prompt).toContain("mcp__arij__*");
    expect(prompt).not.toContain("submit_findings");

    // The token resolves to the session row's identity — the cross-project
    // write barrier the HTTP routes enforce on.
    const record = resolveMcpToken(mcp!.env.ARIJ_MCP_TOKEN);
    expect(record).not.toBeNull();
    expect(record!.sessionId).toBe("s1");
    expect(record!.projectId).toBe("proj-1");
    expect(record!.epicId).toBe("epic-1");
    expect(record!.agentType).toBe("build");
  });

  it("review agent types get the submit_findings + Overall Verdict sentence", () => {
    pmState.sessionRow = sessionRow({ agentType: "review_security" });

    processManager.start("s-review", { mode: "code", prompt: "REVIEW" });

    const prompt = pmState.spawnedOptions[0].prompt as string;
    expect(prompt).toContain("submit_findings");
    expect(prompt).toContain("Overall Verdict");
  });

  it("skips injection when there is no agent_sessions row (generate-spec/import style spawns)", () => {
    pmState.sessionRow = null;

    processManager.start("s2", { mode: "code", prompt: "PLAIN" });

    expect(spawnedMcp()).toBeUndefined();
    expect(pmState.spawnedOptions[0].prompt).toBe("PLAIN");
  });

  it("skips injection when mcp_tools_enabled is explicitly false", () => {
    pmState.sessionRow = sessionRow();
    pmState.settingsRow = { value: JSON.stringify(false) };

    processManager.start("s3", { mode: "code", prompt: "PLAIN" });

    expect(spawnedMcp()).toBeUndefined();
    expect(pmState.spawnedOptions[0].prompt).toBe("PLAIN");
  });

  it("injects when mcp_tools_enabled is explicitly true", () => {
    pmState.sessionRow = sessionRow();
    pmState.settingsRow = { value: JSON.stringify(true) };

    processManager.start("s4", { mode: "code", prompt: "PLAIN" });

    expect(spawnedMcp()).toBeDefined();
  });

  it("skips injection for unsupported providers without touching the db", () => {
    pmState.sessionRow = sessionRow();

    processManager.start("s5", { mode: "code", prompt: "PLAIN" }, "gemini-cli");

    const options = pmState.providerSpawnedOptions[0];
    expect(options.mcp).toBeUndefined();
    expect(options.prompt).toBe("PLAIN");
    // provider gate short-circuits before any settings/session read
    expect(pmState.selectGets.length).toBe(0);
  });

  it("forwards the config to the codex provider spawn options", () => {
    pmState.sessionRow = sessionRow({ agentType: "ticket_build" });

    processManager.start("s6", { mode: "code", prompt: "BASE" }, "codex");

    const options = pmState.providerSpawnedOptions[0];
    const mcp = options.mcp as McpSpawnConfig | undefined;
    expect(mcp).toBeDefined();
    expect(mcp!.serverName).toBe("arij");
    expect(options.prompt as string).toContain("## Arij tools");
  });

  it("injects for oh-my-pi with omp's single-underscore tool spelling", () => {
    pmState.sessionRow = sessionRow();

    processManager.start("s6b", { mode: "code", prompt: "BASE" }, "oh-my-pi");

    const options = pmState.providerSpawnedOptions[0];
    const mcp = options.mcp as McpSpawnConfig | undefined;
    expect(mcp).toBeDefined();
    expect(mcp!.allowedToolNames).toContain("mcp__arij_get_ticket");
    expect(mcp!.allowedToolNames).not.toContain("mcp__arij__get_ticket");
    expect(mcp!.env.ARIJ_MCP_TOKEN).toMatch(/^arij-mcp-/);

    // the prompt names the tools in omp's spelling, never claude's
    const prompt = options.prompt as string;
    expect(prompt).toContain("## Arij tools");
    expect(prompt).toContain("mcp__arij_*");
    expect(prompt).not.toContain("mcp__arij__");
  });

  it("survives a broken db lookup and spawns without injection", () => {
    pmState.sessionRow = sessionRow();
    pmState.throwOnSelect = true;

    expect(() =>
      processManager.start("s7", { mode: "code", prompt: "PLAIN" }),
    ).not.toThrow();

    expect(spawnedMcp()).toBeUndefined();
    expect(pmState.spawnedOptions[0].prompt).toBe("PLAIN");
  });
});

describe("processManager — MCP token lifecycle", () => {
  beforeEach(async () => {
    await resetAll();
    pmState.sessionRow = sessionRow();
  });

  it("revokes the token on completion but keeps the record for classification", async () => {
    processManager.start("t1", { mode: "code", prompt: "P" });
    const token = spawnedMcp()!.env.ARIJ_MCP_TOKEN;
    expect(resolveMcpToken(token)).not.toBeNull();

    pmState.resolveSpawn!({ success: true, result: "done", duration: 5 });
    await flushPromises();

    // auth invalidated…
    expect(resolveMcpToken(token)).toBeNull();
    // …but the record survives: markQuestionAsked still finds it (the
    // askedQuestion flag must stay readable by classifySessionOutcome).
    expect(markQuestionAsked("t1")).toBe(true);
  });

  it("revokes the token when the spawn promise rejects", async () => {
    processManager.start("t2", { mode: "code", prompt: "P" });
    const token = spawnedMcp()!.env.ARIJ_MCP_TOKEN;

    pmState.rejectSpawn!(new Error("boom"));
    await flushPromises();

    expect(resolveMcpToken(token)).toBeNull();
  });

  it("revokes the token on cancel() without waiting for process exit", () => {
    processManager.start("t3", { mode: "code", prompt: "P" });
    const token = spawnedMcp()!.env.ARIJ_MCP_TOKEN;
    expect(resolveMcpToken(token)).not.toBeNull();

    expect(processManager.cancel("t3")).toBe(true);

    expect(resolveMcpToken(token)).toBeNull();
  });

  it("mints a fresh token for a restarted session", async () => {
    processManager.start("t4", { mode: "code", prompt: "P" });
    const first = spawnedMcp(0)!.env.ARIJ_MCP_TOKEN;
    pmState.resolveSpawn!({ success: true, result: "ok", duration: 1 });
    await flushPromises();

    processManager.start("t4", { mode: "code", prompt: "P" });
    const second = spawnedMcp(1)!.env.ARIJ_MCP_TOKEN;

    expect(second).not.toBe(first);
    expect(resolveMcpToken(first)).toBeNull();
    expect(resolveMcpToken(second)).not.toBeNull();
    expect(resolveMcpToken(second)!.sessionId).toBe("t4");
  });
});
