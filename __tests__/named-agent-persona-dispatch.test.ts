/**
 * Persona and per-CLI options at the single dispatch wiring point.
 *
 * processManager.start() is where every dispatch path meets the CLI — manual
 * routes, pipeline stages, night runs and Full Auto all funnel through it —
 * so resolving the named agent's persona and options HERE is what makes the
 * automated modes inherit them without a plumbing of their own. These tests
 * drive start() directly and assert what reached the provider.
 *
 * Mock style follows __tests__/mcp-injection-lifecycle.test.ts (hand-rolled
 * hoisted mocks; the shared db-mock helper is incompatible with
 * vi.resetModules).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pmState = vi.hoisted(() => ({
  /** named_agent_id on the session row start() reads. */
  namedAgentId: null as string | null,
  /** agent_type on that row — what scopes the persona and the options. */
  agentType: "build" as string | null,
  /** What getNamedAgentRuntimeConfig should answer, keyed by agent id. */
  agents: new Map<
    string,
    { options: Record<string, unknown>; personaPrompt: string | null }
  >(),
  /** (agentId, provider) pairs the resolver was asked about. */
  runtimeLookups: [] as Array<{ agentId: unknown; provider: unknown }>,
  throwOnSelect: false,
  updates: [] as Array<Record<string, unknown>>,
  spawnedOptions: [] as Array<Record<string, unknown>>,
  providerSpawnedOptions: [] as Array<Record<string, unknown>>,
}));

const tables = vi.hoisted(() => ({
  agentSessions: {
    id: "agent_sessions.id",
    projectId: "agent_sessions.project_id",
    epicId: "agent_sessions.epic_id",
    userStoryId: "agent_sessions.user_story_id",
    agentType: "agent_sessions.agent_type",
    namedAgentId: "agent_sessions.named_agent_id",
  },
  settings: { key: "settings.key", value: "settings.value" },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({})) }));
vi.mock("@/lib/db/schema", () => tables);

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => {
      if (pmState.throwOnSelect) throw new Error("db exploded");
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(() => ({
              projectId: "proj-1",
              epicId: "epic-1",
              userStoryId: null,
              agentType: pmState.agentType,
              namedAgentId: pmState.namedAgentId,
            })),
          })),
        })),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        pmState.updates.push(patch);
        return { where: vi.fn(() => ({ run: vi.fn() })) };
      }),
    })),
  },
}));

// MCP injection is a separate concern with its own suite; switching it off
// keeps these assertions about the persona alone.
vi.mock("@/lib/claude/mcp-injection", () => ({
  isMcpToolsEnabled: () => false,
  providerSupportsMcp: () => false,
  arijMcpToolPrefix: () => "mcp__arij__",
  buildMcpSpawnConfig: vi.fn(),
  cleanupMcpConfigFile: vi.fn(),
}));

vi.mock("@/lib/agent-config/named-agents", () => ({
  getNamedAgentRuntimeConfig: vi.fn((agentId: unknown, provider: unknown) => {
    pmState.runtimeLookups.push({ agentId, provider });
    const found =
      typeof agentId === "string" ? pmState.agents.get(agentId) : undefined;
    return found ?? { options: {}, personaPrompt: null };
  }),
}));

vi.mock("@/lib/agent-sessions/chunks", () => ({ appendSessionChunk: vi.fn() }));

vi.mock("@/lib/claude/spawn", () => ({
  spawnClaude: vi.fn((options: Record<string, unknown>) => {
    pmState.spawnedOptions.push({ ...options });
    return {
      promise: new Promise(() => {}),
      kill: vi.fn(),
      command: "claude <prompt>",
    };
  }),
}));

vi.mock("@/lib/providers", () => ({
  getProvider: vi.fn((provider: string) => ({
    type: provider,
    spawn: vi.fn((options: Record<string, unknown>) => {
      pmState.providerSpawnedOptions.push({ ...options });
      return {
        handle: `${provider}-test`,
        kill: vi.fn(),
        promise: new Promise(() => {}),
        command: `${provider} <prompt>`,
      };
    }),
    cancel: vi.fn(() => true),
    isAvailable: vi.fn().mockResolvedValue(true),
  })),
}));

import { PERSONA_HEADING } from "@/lib/claude/prompt-sections";

let processManager: typeof import("@/lib/claude/process-manager").processManager;

/** A prompt shaped like a real build prompt: role prompt, spec, then task. */
const BUILD_PROMPT = [
  "# System Instructions",
  "",
  "You are the build agent.",
  "",
  "# Project: Arij",
  "## Project Specification",
  "",
  "The project spec body.",
  "",
  "## Epic to Implement",
  "",
  "## Instructions",
  "",
  "Implement this epic.",
].join("\n");

beforeEach(async () => {
  vi.clearAllMocks();
  pmState.namedAgentId = null;
  pmState.agentType = "build";
  pmState.agents = new Map();
  pmState.runtimeLookups = [];
  pmState.throwOnSelect = false;
  pmState.updates = [];
  pmState.spawnedOptions = [];
  pmState.providerSpawnedOptions = [];
  vi.resetModules();
  processManager = (await import("@/lib/claude/process-manager")).processManager;
});

function configureAgent(
  id: string,
  config: {
    options?: Record<string, unknown>;
    personaPrompt?: string | null;
    agentType?: string | null;
  },
) {
  pmState.namedAgentId = id;
  if (config.agentType !== undefined) pmState.agentType = config.agentType;
  pmState.agents.set(id, {
    options: config.options ?? {},
    personaPrompt: config.personaPrompt ?? null,
  });
}

describe("persona injection", () => {
  it("prepends the persona as its own section, ahead of everything else", () => {
    configureAgent("agent-1", {
      personaPrompt: "You're an experienced developer",
    });

    processManager.start("s-1", { mode: "code", prompt: BUILD_PROMPT });

    const prompt = pmState.spawnedOptions[0].prompt as string;
    expect(prompt.startsWith(`## ${PERSONA_HEADING}\n`)).toBe(true);
    expect(prompt).toContain("You're an experienced developer");

    // Documented order: persona, then the role prompt (the global- or
    // project-scoped agent prompt), then the specification, then the task.
    const personaAt = prompt.indexOf(`## ${PERSONA_HEADING}`);
    const rolePromptAt = prompt.indexOf("# System Instructions");
    const specAt = prompt.indexOf("## Project Specification");
    const taskAt = prompt.indexOf("## Instructions");
    expect(personaAt).toBeLessThan(rolePromptAt);
    expect(rolePromptAt).toBeLessThan(specAt);
    expect(specAt).toBeLessThan(taskAt);

    // The original prompt survives verbatim after the injected block.
    expect(prompt.endsWith(BUILD_PROMPT)).toBe(true);
  });

  it("leaves the prompt untouched when the agent has no persona", () => {
    configureAgent("agent-1", { personaPrompt: null });

    processManager.start("s-1", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].prompt).toBe(BUILD_PROMPT);
    expect(
      pmState.updates.some((patch) => "prompt" in patch),
    ).toBe(false);
  });

  it("leaves the prompt untouched for a session with no named agent", () => {
    pmState.namedAgentId = null;

    processManager.start("s-1", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].prompt).toBe(BUILD_PROMPT);
  });

  it("re-persists the prompt so the session detail shows what was sent", () => {
    configureAgent("agent-1", { personaPrompt: "Be rigorous" });

    processManager.start("s-1", { mode: "code", prompt: BUILD_PROMPT });

    const patch = pmState.updates.find((candidate) => "prompt" in candidate);
    expect(patch?.prompt).toBe(pmState.spawnedOptions[0].prompt);
    expect(patch?.prompt).toContain("Be rigorous");
  });

  it("does not stack a second persona when the same options object is re-dispatched", () => {
    // The retry ladder re-dispatches a stage; a mutated caller object would
    // grow one persona block per attempt.
    configureAgent("agent-1", { personaPrompt: "Be rigorous" });
    const options = { mode: "code" as const, prompt: BUILD_PROMPT };

    processManager.start("s-1", options);
    processManager.start("s-2", options);

    for (const spawned of pmState.spawnedOptions) {
      const prompt = spawned.prompt as string;
      expect(prompt.split(`## ${PERSONA_HEADING}`)).toHaveLength(2);
    }
    expect(options.prompt).toBe(BUILD_PROMPT);
  });
});

describe("persona scoping by agent type", () => {
  /**
   * The document rewriters persist their ENTIRE response verbatim:
   * spec_generation replaces projects.spec, the memory writers replace the
   * memory document, release_notes becomes CHANGELOG.md. A persona such as
   * "answer in French and summarise your reasoning" would be written into
   * that stored artifact, which then feeds every later prompt.
   */
  it.each([
    "spec_generation",
    "dreaming",
    "memory_distill",
    "release_notes",
    "title_generation",
    "import_analysis",
    "failure_digest",
    "refinement",
    "tech_check",
    "e2e_test",
    "forensic",
  ])("injects nothing into a %s session", (agentType) => {
    configureAgent("agent-1", {
      agentType,
      personaPrompt: "Answer in French and summarise your reasoning",
    });

    processManager.start("s-doc", { mode: "plan", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].prompt).toBe(BUILD_PROMPT);
    expect(pmState.updates.some((patch) => "prompt" in patch)).toBe(false);
  });

  it.each([
    "build",
    "ticket_build",
    "team_build",
    "review_security",
    "review_code",
    "review_compliance",
    "review_feature",
    "review_second_opinion",
    "grading",
    "merge",
  ])("injects into a %s session", (agentType) => {
    configureAgent("agent-1", { agentType, personaPrompt: "Be rigorous" });

    processManager.start("s-work", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].prompt).toContain(
      `## ${PERSONA_HEADING}`,
    );
  });

  it("injects nothing when the session carries no agent type", () => {
    // Allowlist, not blocklist: an unnamed role gets no persona rather than
    // inheriting one into an output contract nobody has checked.
    configureAgent("agent-1", { agentType: null, personaPrompt: "Be rigorous" });

    processManager.start("s-unknown", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].prompt).toBe(BUILD_PROMPT);
  });
});

describe("permission mode scoping by agent type", () => {
  /**
   * Reviews, grading and the second-opinion gate spawn in mode "code" on
   * purpose — plan mode refuses the mutating MCP tools they exist to call —
   * so the spawn mode cannot tell them apart from a build. Only the agent
   * type can.
   */
  it("keeps the permission mode for a build", () => {
    configureAgent("agent-1", {
      agentType: "build",
      options: { effort: "high", permission_mode: "acceptEdits" },
    });

    processManager.start("s-build", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].cliOptions).toEqual({
      effort: "high",
      permission_mode: "acceptEdits",
    });
  });

  it("strips it from a review that spawns in code mode", () => {
    configureAgent("agent-1", {
      agentType: "review_code",
      options: { effort: "high", permission_mode: "acceptEdits" },
    });

    processManager.start("s-review", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].cliOptions).toEqual({ effort: "high" });
    // And the audit trail records what was actually in effect, not what the
    // agent was configured with.
    const patch = pmState.updates.find((candidate) => "cliOptions" in candidate);
    expect(patch?.cliOptions).toBe('{"effort":"high"}');
  });

  it("writes no options row when stripping leaves nothing", () => {
    configureAgent("agent-1", {
      agentType: "grading",
      options: { permission_mode: "bypassPermissions" },
    });

    processManager.start("s-grade", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].cliOptions).toBeUndefined();
    expect(pmState.updates.some((patch) => "cliOptions" in patch)).toBe(false);
  });
});

describe("option propagation", () => {
  it("hands claude-code its options and records them on the session row", () => {
    configureAgent("agent-1", { options: { effort: "xhigh" } });

    processManager.start("s-1", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].cliOptions).toEqual({ effort: "xhigh" });
    const patch = pmState.updates.find((candidate) => "cliOptions" in candidate);
    expect(patch?.cliOptions).toBe('{"effort":"xhigh"}');
  });

  it("hands a non-claude provider its options", () => {
    configureAgent("agent-1", { options: { thinking: "high" } });

    processManager.start(
      "s-1",
      { mode: "code", prompt: BUILD_PROMPT },
      "oh-my-pi",
    );

    expect(pmState.providerSpawnedOptions[0].cliOptions).toEqual({
      thinking: "high",
    });
  });

  it("resolves options against the provider this session spawns on", () => {
    // Review-provider segregation can put a reviewer on a different CLI from
    // the builder. The resolver is asked about the SPAWNING provider so a
    // mismatch degrades to no options instead of a fatal unknown flag.
    configureAgent("agent-reviewer", { options: { thinking: "max" } });

    processManager.start(
      "s-review",
      { mode: "plan", prompt: BUILD_PROMPT },
      "oh-my-pi",
    );

    expect(pmState.runtimeLookups).toEqual([
      { agentId: "agent-reviewer", provider: "oh-my-pi" },
    ]);
  });

  it("writes nothing to the session row when no option is configured", () => {
    configureAgent("agent-1", { options: {} });

    processManager.start("s-1", { mode: "code", prompt: BUILD_PROMPT });

    expect(pmState.spawnedOptions[0].cliOptions).toBeUndefined();
    expect(pmState.updates.some((patch) => "cliOptions" in patch)).toBe(false);
  });

  it("still spawns when the agent configuration cannot be read", () => {
    // Optional configuration must never be the reason a session fails to run.
    pmState.throwOnSelect = true;

    expect(() =>
      processManager.start("s-1", { mode: "code", prompt: BUILD_PROMPT }),
    ).not.toThrow();
    expect(pmState.spawnedOptions[0].prompt).toBe(BUILD_PROMPT);
  });
});
