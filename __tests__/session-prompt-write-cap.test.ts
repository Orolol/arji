/**
 * The WRITE-path cap on `agent_sessions.prompt`.
 *
 * `createQueuedSession` used to store whatever the dispatch route composed,
 * at any size. Measured on the live database (2026-09-05): 939 sessions carry
 * a prompt, 68.9 MB in total, average 71.7 KB, largest 4.97 MB — the
 * prompt-snowball feedback loop, materialised in storage long after the
 * prompt-side budgets in `lib/claude/prompt-builder.ts` capped what goes OUT.
 *
 * The stored prompt is diagnostic: nothing replays it. These tests pin that
 * claim as much as the cap itself — an oversized prompt is stored head +
 * marker + tail, an ordinary one byte-identical, the token estimate still
 * describes the WHOLE prompt the agent received, and resume and retry (which
 * read provider and session identity) still work off a capped row.
 */
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { agentSessions, epics, projects } = await import("@/lib/db/schema");
const { capSessionPrompt, createQueuedSession } = await import(
  "@/lib/agent-sessions/lifecycle"
);
const {
  isPromptElisionMarker,
  promptElisionMarker,
  SESSION_PROMPT_ELISION_LABEL,
  SESSION_PROMPT_MAX_STORED_BYTES,
  SESSION_PROMPT_STORED_HEAD_BYTES,
  SESSION_PROMPT_STORED_TAIL_BYTES,
  splitCappedPrompt,
} = await import("@/lib/agent-sessions/prompt-cap");
const { validateResumeSession } = await import(
  "@/lib/agent-sessions/validate-resume"
);
const { buildRetryDispatch } = await import(
  "@/lib/agent-sessions/retry-dispatch"
);

const PROJECT_ID = "proj-prompt-cap";
const EPIC_ID = "epic-prompt-cap";

function seedScope(): void {
  const existing = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, PROJECT_ID))
    .get();
  if (existing) return;
  db.insert(projects).values({ id: PROJECT_ID, name: "Prompt cap" }).run();
  db.insert(epics)
    .values({ id: EPIC_ID, projectId: PROJECT_ID, title: "Cap the prompt" })
    .run();
}

let nextId = 0;

/** Queue a session and hand back what SQLite actually holds for it. */
function queueAndRead(
  values: Partial<typeof agentSessions.$inferInsert> = {}
): {
  id: string;
  prompt: string | null;
  estimatedPromptTokens: number | null;
} {
  seedScope();
  const id = `sess-prompt-cap-${++nextId}`;
  createQueuedSession({
    id,
    projectId: PROJECT_ID,
    epicId: EPIC_ID,
    agentType: "build",
    createdAt: "2026-09-05T09:00:00.000Z",
    ...values,
  });
  const row = db
    .select({
      prompt: agentSessions.prompt,
      estimatedPromptTokens: agentSessions.estimatedPromptTokens,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, id))
    .get();
  return { id, ...(row as { prompt: string | null; estimatedPromptTokens: number | null }) };
}

/** The shape a snowballed prompt actually has: a header, bulk, then the task. */
function oversizedPrompt(): string {
  const bulk = `## Project Specification\n${"spec line\n".repeat(60_000)}`;
  return `# Project: Arij\n${bulk}\n## Instructions\n\nImplement the ticket.`;
}

describe("createQueuedSession prompt cap", () => {
  it("stores an oversized prompt capped, with head, tail and the marker", () => {
    const prompt = oversizedPrompt();
    expect(Buffer.byteLength(prompt, "utf8")).toBeGreaterThan(
      SESSION_PROMPT_MAX_STORED_BYTES * 4
    );

    const stored = queueAndRead({ prompt }).prompt as string;

    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      SESSION_PROMPT_MAX_STORED_BYTES
    );
    expect(stored).not.toBe(prompt);
    // The head is where the system section and the project header live; the
    // tail is where the task — and, at spawn time, the Arij tools section —
    // does. Both survive.
    expect(stored.startsWith("# Project: Arij\n")).toBe(true);
    expect(stored.endsWith("## Instructions\n\nImplement the ticket.")).toBe(
      true
    );

    const markerLine = stored
      .split("\n")
      .find((line) => isPromptElisionMarker(line));
    expect(markerLine).toBeDefined();
    expect(markerLine).toContain(SESSION_PROMPT_ELISION_LABEL);

    // The marker's number is the bytes actually dropped, not a guess: head +
    // marker line + tail + the two newlines must add back up to the original.
    const elided = Number(
      /\[… ([\d,]+) bytes/.exec(markerLine as string)![1].replace(/,/g, "")
    );
    const kept =
      Buffer.byteLength(stored, "utf8") -
      Buffer.byteLength(`\n${markerLine}\n`, "utf8");
    expect(kept + elided).toBe(Buffer.byteLength(prompt, "utf8"));
  });

  it("stores an ordinary prompt byte-identical", () => {
    // 96% of live rows are under the cap; they must round-trip untouched,
    // including the awkward parts — trailing whitespace, blank lines, and a
    // bracket run that is NOT the marker.
    const prompt = `# Project: Arij\n\n[… 12 bytes elided …]  \n\n${"context line\n".repeat(200)}`;
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(
      SESSION_PROMPT_MAX_STORED_BYTES
    );

    const stored = queueAndRead({ prompt }).prompt;

    expect(stored).toBe(prompt);
    expect(splitCappedPrompt(stored as string)).toBeNull();
  });

  it("stores NULL rather than an empty string when there is no prompt", () => {
    // Every dispatch path composes one today, but the column and the insert
    // type both allow NULL, and `""` reads differently downstream.
    expect(queueAndRead({ prompt: null }).prompt).toBeNull();
    expect(queueAndRead({}).prompt).toBeNull();
  });

  it("estimates tokens from the WHOLE prompt, not from the capped row", () => {
    // Same invariant as `lastNonEmptyText` on the chunk cap: the estimate
    // describes what the agent was handed. Deriving it from the stored row
    // would under-report exactly the runs whose size is worth knowing about.
    const prompt = oversizedPrompt();
    const { estimatedPromptTokens, prompt: stored } = queueAndRead({ prompt });

    expect(estimatedPromptTokens).not.toBeNull();
    // Four times the cap of input cannot estimate to a cap-sized prompt's
    // worth of tokens; the bound is deliberately generous, the point is the
    // order of magnitude.
    expect(estimatedPromptTokens as number).toBeGreaterThan(
      SESSION_PROMPT_MAX_STORED_BYTES / 4
    );
    expect(Buffer.byteLength(stored as string, "utf8")).toBeLessThanOrEqual(
      SESSION_PROMPT_MAX_STORED_BYTES
    );
  });

  it("caps an explicitly supplied estimate not at all — it is the caller's", () => {
    const prompt = oversizedPrompt();
    const { estimatedPromptTokens } = queueAndRead({
      prompt,
      estimatedPromptTokens: 4242,
    });
    expect(estimatedPromptTokens).toBe(4242);
  });
});

describe("capSessionPrompt", () => {
  it("never cuts inside a multi-byte character", () => {
    // Every byte of the head and tail boundaries lands mid-character unless
    // the cut walks off continuation bytes: "é" is 2 bytes, "→" 3, "🌊" 4.
    const unit = "é→🌊";
    const prompt = unit.repeat(
      Math.ceil((SESSION_PROMPT_MAX_STORED_BYTES * 3) / Buffer.byteLength(unit))
    );

    const stored = capSessionPrompt(prompt);

    expect(stored).not.toContain("�");
    expect(Buffer.byteLength(stored, "utf8")).toBeLessThanOrEqual(
      SESSION_PROMPT_MAX_STORED_BYTES
    );
    // Round-tripping through UTF-8 must be a no-op — the proof that no
    // half-character survived the cut.
    expect(Buffer.from(stored, "utf8").toString("utf8")).toBe(stored);
  });

  it("keeps head and tail under the cap, with room for the marker", () => {
    // The slack the split leaves is what makes a capped prompt strictly under
    // the cap rather than one marker over it.
    expect(
      SESSION_PROMPT_STORED_HEAD_BYTES + SESSION_PROMPT_STORED_TAIL_BYTES
    ).toBeLessThan(SESSION_PROMPT_MAX_STORED_BYTES);
    expect(
      SESSION_PROMPT_MAX_STORED_BYTES -
        SESSION_PROMPT_STORED_HEAD_BYTES -
        SESSION_PROMPT_STORED_TAIL_BYTES
    ).toBeGreaterThan(Buffer.byteLength(promptElisionMarker(4_856_320), "utf8"));
  });

  it("names the cap and its diagnostic purpose in the marker itself", () => {
    expect(SESSION_PROMPT_ELISION_LABEL).toContain(
      `${SESSION_PROMPT_MAX_STORED_BYTES / 1024} KiB`
    );
    expect(SESSION_PROMPT_ELISION_LABEL).toContain("diagnostics");
    expect(isPromptElisionMarker(promptElisionMarker(42))).toBe(true);
    expect(isPromptElisionMarker(`  ${promptElisionMarker(42)}  `)).toBe(true);
    expect(isPromptElisionMarker("[… 42 bytes elided …]")).toBe(false);
    expect(isPromptElisionMarker("ordinary prompt text")).toBe(false);
  });

  it("splits a capped prompt back into the two ends it kept", () => {
    const prompt = oversizedPrompt();
    const parts = splitCappedPrompt(capSessionPrompt(prompt));

    expect(parts).not.toBeNull();
    // The ends as they were cut — the newlines the writer added around the
    // marker are not part of them, which is what lets the echo scrub match a
    // full echo of the original from head to tail.
    expect(prompt.startsWith(parts!.head)).toBe(true);
    expect(prompt.endsWith(parts!.tail)).toBe(true);
  });

  it("recovers the original prompt's byte length from the marker", () => {
    const prompt = oversizedPrompt();
    const parts = splitCappedPrompt(capSessionPrompt(prompt))!;

    // The arithmetic the echo scrub closes a span on. Exact, not approximate:
    // the marker records the bytes the cut dropped, so the two kept ends and
    // that count add up to the prompt the CLI was handed. Anything else and a
    // length-driven scrub removes the wrong span.
    expect(
      Buffer.byteLength(parts.head, "utf8") +
        parts.elidedBytes +
        Buffer.byteLength(parts.tail, "utf8"),
    ).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(parts.elidedBytes).toBeGreaterThan(0);
  });

  it("recovers it across a multi-byte cut, where the boundary walk moved the ends", () => {
    // Astral characters straddling both cut points: the head walks back and
    // the tail walks forward, so head + elided + tail only still adds up if
    // the marker was written from the adjusted offsets.
    const prompt = `${"\u{1F30A}".repeat(60_000)}${"e\u0301".repeat(20_000)}`;
    const parts = splitCappedPrompt(capSessionPrompt(prompt))!;

    expect(
      Buffer.byteLength(parts.head, "utf8") +
        parts.elidedBytes +
        Buffer.byteLength(parts.tail, "utf8"),
    ).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(prompt.startsWith(parts.head)).toBe(true);
    expect(prompt.endsWith(parts.tail)).toBe(true);
  });
});

describe("resume and retry read identity, not the stored prompt", () => {
  it("resumes a session whose stored prompt was capped", () => {
    const prompt = oversizedPrompt();
    const { id } = queueAndRead({
      prompt,
      provider: "claude-code",
      cliSessionId: "cli-abc-123",
    });

    // The row really is capped — otherwise this proves nothing.
    const stored = db
      .select({ prompt: agentSessions.prompt })
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .get();
    expect(splitCappedPrompt(stored!.prompt as string)).not.toBeNull();

    expect(
      validateResumeSession({
        resumeSessionId: id,
        epicId: EPIC_ID,
        expectedProvider: "claude-code",
      })
    ).toEqual({ cliSessionId: "cli-abc-123" });
  });

  it("retries a capped-prompt session on its own agent, resuming it", () => {
    const { id } = queueAndRead({
      prompt: oversizedPrompt(),
      provider: "claude-code",
      cliSessionId: "cli-def-456",
    });

    expect(
      buildRetryDispatch(PROJECT_ID, EPIC_ID, {
        sessionId: id,
        error: "Context window exceeded",
        agentType: "build",
        provider: "claude-code",
        namedAgentId: "agent-1",
        producedOutput: true,
      }, null)
    ).toEqual({
      url: `/api/projects/${PROJECT_ID}/epics/${EPIC_ID}/build`,
      body: { namedAgentId: "agent-1", resumeSessionId: id },
    });
  });
});
