/**
 * Spec auto-rewrite ("spec vivante") — end-to-end against the real migrated
 * schema (createTestDb), with the CLI spawn mocked:
 *
 *   - dispatchSpecAutoRewriteSession creates a queued 'spec_generation'
 *     session, runs it through the real scheduler + lifecycle, and on an
 *     answered completion REPLACES projects.spec and re-exports arji.json,
 *   - non-answered outcomes (asked_question) leave the spec untouched,
 *   - accidental full-document code fences are unwrapped,
 *   - the prompt embeds the current spec, the board state (epics/stories/
 *     releases) and the triggering release's changelog,
 *   - maybeAutoRewriteSpecAfterRelease end-to-end: off by default, spawns
 *     exactly one rewrite for an existing release, and every guard denial
 *     (unknown release, pending spec_generation session) spawns nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";

const processManagerState = vi.hoisted(() => ({
  result: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

vi.mock("@/lib/claude/process-manager", () => ({
  processManager: {
    start: vi.fn(),
    getStatus: vi.fn(() => ({
      status: "completed",
      result: processManagerState.result,
    })),
  },
}));

vi.mock("@/lib/agent-config/prompts", () => ({
  resolveAgentPrompt: vi.fn().mockResolvedValue("spec system prompt"),
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    namedAgentId: null,
    name: null,
    model: null,
  })),
}));

vi.mock("@/lib/sync/export", () => ({
  tryExportArjiJson: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => {
      throw new Error("no logs in tests");
    }),
  },
}));

const { db } = await import("@/lib/db");
const { projects, epics, userStories, releases, agentSessions, settings } =
  await import("@/lib/db/schema");
const {
  dispatchSpecAutoRewriteSession,
  maybeAutoRewriteSpecAfterRelease,
  sanitizeRewrittenSpec,
  hasPendingSpecGeneration,
} = await import("@/lib/workflow/spec-auto-rewrite");
const { tryExportArjiJson } = await import("@/lib/sync/export");

let counter = 0;

async function flushBackground() {
  await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 25));
}

function claudeEnvelope(text: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: text,
  });
}

interface SeedResult {
  projectId: string;
  epicId: string;
  releaseId: string;
}

function seedProjectWithRelease(): SeedResult {
  counter += 1;
  const projectId = `proj-specrw-${counter}`;
  const epicId = `epic-specrw-${counter}`;
  const releaseId = `rel-specrw-${counter}`;
  db.insert(projects)
    .values({
      id: projectId,
      name: "Spec Project",
      gitRepoPath: "/repos/s",
      spec: "# Old spec\n\nPlanned: checkout flow.",
    })
    .run();
  db.insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Checkout flow",
      status: "released",
      position: 0,
      readableId: `E-s-${counter}`,
    })
    .run();
  db.insert(userStories)
    .values({
      id: `story-specrw-${counter}`,
      epicId,
      title: "Cart page",
      status: "done",
      position: 0,
    })
    .run();
  db.insert(releases)
    .values({
      id: releaseId,
      projectId,
      version: "0.1.0",
      title: "First release",
      changelog: "## Features\n\n- Checkout flow",
      epicIds: JSON.stringify([epicId]),
      createdAt: new Date().toISOString(),
    })
    .run();
  return { projectId, epicId, releaseId };
}

function enableAutoRewrite() {
  db.insert(settings)
    .values({ key: "spec_auto_rewrite", value: "true" })
    .run();
}

function specSessions(projectId: string) {
  return db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.projectId, projectId))
    .all()
    .filter((row) => row.agentType === "spec_generation");
}

function getSpec(projectId: string): string | null {
  return (
    db
      .select({ spec: projects.spec })
      .from(projects)
      .where(eq(projects.id, projectId))
      .get()?.spec ?? null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.delete(settings).where(eq(settings.key, "spec_auto_rewrite")).run();
  processManagerState.result = {
    success: true,
    result: claudeEnvelope("# Rewritten spec\n\nCheckout flow is live."),
    duration: 1000,
  };
});

describe("dispatchSpecAutoRewriteSession", () => {
  it("runs a spec_generation session and replaces the spec on answered completion", async () => {
    const { projectId, releaseId } = seedProjectWithRelease();

    const { sessionId } = await dispatchSpecAutoRewriteSession({
      projectId,
      releaseId,
    });
    await flushBackground();

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    expect(session).toMatchObject({
      agentType: "spec_generation",
      status: "completed",
      outcome: "answered",
      projectId,
      mode: "plan",
      epicId: null, // never holds an epic slot
    });

    // Prompt embeds the current spec, the board state and the release.
    expect(session!.prompt).toContain("## Current Specification");
    expect(session!.prompt).toContain("# Old spec");
    expect(session!.prompt).toContain("**Checkout flow** — released");
    expect(session!.prompt).toContain("- Cart page (done)");
    expect(session!.prompt).toContain("### Release History");
    expect(session!.prompt).toContain("## Release That Just Shipped");
    expect(session!.prompt).toContain("Checkout flow");
    expect(session!.prompt).toContain("spec system prompt");

    // The spec was replaced with the agent's output.
    expect(getSpec(projectId)).toBe("# Rewritten spec\n\nCheckout flow is live.");

    // arji.json re-export fired after the spec write.
    expect(tryExportArjiJson).toHaveBeenCalledWith(projectId);
  });

  it("unwraps an accidental full-document code fence", async () => {
    const { projectId, releaseId } = seedProjectWithRelease();
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("```markdown\n# Fenced spec\n```"),
      duration: 1000,
    };

    await dispatchSpecAutoRewriteSession({ projectId, releaseId });
    await flushBackground();

    expect(getSpec(projectId)).toBe("# Fenced spec");
  });

  it("leaves the spec untouched when the run asks a question", async () => {
    const { projectId, releaseId } = seedProjectWithRelease();
    processManagerState.result = {
      success: true,
      result: claudeEnvelope("Should I keep the roadmap section?"),
      endedWithQuestion: true,
      duration: 1000,
    };

    const { sessionId } = await dispatchSpecAutoRewriteSession({
      projectId,
      releaseId,
    });
    await flushBackground();

    const session = db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    expect(session!.outcome).toBe("asked_question");
    expect(getSpec(projectId)).toBe("# Old spec\n\nPlanned: checkout flow.");
    expect(tryExportArjiJson).not.toHaveBeenCalled();
  });

  it("throws for an unknown project", async () => {
    await expect(
      dispatchSpecAutoRewriteSession({ projectId: "nope", releaseId: "rel" })
    ).rejects.toThrow("Project not found");
  });

  it("throws for a release outside the project", async () => {
    const { projectId } = seedProjectWithRelease();
    await expect(
      dispatchSpecAutoRewriteSession({ projectId, releaseId: "rel-nope" })
    ).rejects.toThrow("Release not found");
  });
});

describe("hasPendingSpecGeneration", () => {
  it("sees queued and running spec_generation sessions of ANY origin", async () => {
    const { projectId } = seedProjectWithRelease();
    expect(hasPendingSpecGeneration(projectId)).toBe(false);

    db.insert(agentSessions)
      .values({
        id: `pending-${counter}`,
        projectId,
        status: "running",
        agentType: "spec_generation", // e.g. the manual update flow
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(hasPendingSpecGeneration(projectId)).toBe(true);
  });
});

describe("maybeAutoRewriteSpecAfterRelease", () => {
  it("is a no-op when the setting is off (the default)", async () => {
    const { projectId, releaseId } = seedProjectWithRelease();

    const decision = await maybeAutoRewriteSpecAfterRelease(projectId, releaseId);

    expect(decision.allowed).toBe(false);
    expect(specSessions(projectId)).toHaveLength(0);
  });

  it("dispatches exactly one rewrite for an existing release when enabled", async () => {
    const { projectId, releaseId } = seedProjectWithRelease();
    enableAutoRewrite();

    const decision = await maybeAutoRewriteSpecAfterRelease(projectId, releaseId);
    expect(decision.allowed).toBe(true);

    await flushBackground();

    expect(specSessions(projectId)).toHaveLength(1);
    expect(getSpec(projectId)).toBe("# Rewritten spec\n\nCheckout flow is live.");
  });

  it("denies an unknown release without dispatching", async () => {
    const { projectId } = seedProjectWithRelease();
    enableAutoRewrite();

    const decision = await maybeAutoRewriteSpecAfterRelease(projectId, "rel-nope");

    expect(decision.allowed).toBe(false);
    expect(specSessions(projectId)).toHaveLength(0);
  });

  it("denies while a spec update (manual or auto) is already pending", async () => {
    const { projectId, releaseId } = seedProjectWithRelease();
    enableAutoRewrite();
    db.insert(agentSessions)
      .values({
        id: `pending-${counter}`,
        projectId,
        status: "queued",
        agentType: "spec_generation",
        createdAt: new Date().toISOString(),
      })
      .run();

    const decision = await maybeAutoRewriteSpecAfterRelease(projectId, releaseId);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("already queued/running");
    // Only the pre-existing session — no second dispatch.
    expect(specSessions(projectId)).toHaveLength(1);
  });
});

describe("sanitizeRewrittenSpec", () => {
  it("trims plain output and unwraps fences", () => {
    expect(sanitizeRewrittenSpec("  body  ")).toBe("body");
    expect(sanitizeRewrittenSpec("```\nbody\n```")).toBe("body");
    expect(sanitizeRewrittenSpec("```md\nbody\n```")).toBe("body");
    expect(sanitizeRewrittenSpec("```markdown\nbody\n```")).toBe("body");
    // An inner fence pair stays untouched.
    expect(sanitizeRewrittenSpec("a\n```ts\nx\n```\nb")).toBe(
      "a\n```ts\nx\n```\nb"
    );
  });
});
