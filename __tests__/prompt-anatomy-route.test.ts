/**
 * GET /api/projects/[projectId]/prompt-anatomy — the data behind frame 8b's
 * ANATOMIE DU PROMPT band.
 *
 * Everything it returns is READ from what dispatch already persisted in
 * `agent_sessions.estimated_prompt_breakdown`, with exactly one computed
 * addition: the persona, which process-manager prepends AFTER the dispatch-time
 * estimate is taken and which therefore never appears in a stored breakdown.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { nanoid } from "nanoid";

import { GET } from "@/app/api/projects/[projectId]/prompt-anatomy/route";
import { db } from "@/lib/db";
import {
  agentSessions,
  epics,
  namedAgents,
  projects,
  userStories,
} from "@/lib/db/schema";
import { personaSection } from "@/lib/claude/prompt-sections";
import { estimateTokens } from "@/lib/tokens/estimator";
import type { PromptAnatomyRow } from "@/components/spec/spec-format";

function getAnatomy(projectId: string) {
  const request = new NextRequest(
    `http://localhost/api/projects/${projectId}/prompt-anatomy`,
  );
  return GET(request, { params: Promise.resolve({ projectId }) });
}

async function rowsOf(projectId: string): Promise<PromptAnatomyRow[]> {
  const res = await getAnatomy(projectId);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { rows: PromptAnatomyRow[] } };
  return json.data.rows;
}

const FULL_BREAKDOWN = {
  spec: 3100,
  memory: 1100,
  ticket: 4000,
  comments: 900,
  findings: 900,
  documents: 2400,
  system: 1000,
  other: 300,
};

let projectId: string;

function makeProject(): string {
  const id = `proj-${nanoid(6)}`;
  db.insert(projects).values({ id, name: "Anatomy Project" }).run();
  return id;
}

function makeAgent(name: string, personaPrompt: string | null): string {
  const id = `agent-${nanoid(6)}`;
  db.insert(namedAgents)
    .values({
      id,
      name: `${name}-${nanoid(4)}`,
      provider: "claude-code",
      model: "opus",
      personaPrompt,
    })
    .run();
  return id;
}

function makeEpic(project: string, type: "feature" | "bug"): string {
  const id = `epic-${nanoid(6)}`;
  db.insert(epics)
    .values({ id, projectId: project, title: "Ticket", type })
    .run();
  return id;
}

function makeSession(values: {
  project?: string;
  agentId?: string | null;
  agentName?: string | null;
  agentType: string;
  epicId?: string | null;
  createdAt: string;
  breakdown?: unknown;
  rawBreakdown?: string;
  estimatedPromptTokens?: number;
}): string {
  const id = `sess-${nanoid(6)}`;
  db.insert(agentSessions)
    .values({
      id,
      projectId: values.project ?? projectId,
      epicId: values.epicId ?? null,
      agentType: values.agentType,
      namedAgentId: values.agentId ?? null,
      namedAgentName: values.agentName ?? null,
      createdAt: values.createdAt,
      estimatedPromptTokens: values.estimatedPromptTokens ?? 1,
      estimatedPromptBreakdown:
        values.rawBreakdown ??
        JSON.stringify(values.breakdown ?? FULL_BREAKDOWN),
    })
    .run();
  return id;
}

beforeEach(() => {
  projectId = makeProject();
});

describe("prompt-anatomy route", () => {
  it("404s for an unknown project", async () => {
    const res = await getAnatomy(`proj-missing-${nanoid(6)}`);
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBeTruthy();
  });

  it("returns an empty row list — 200, not 404 — for a project with no estimated session", async () => {
    const res = await getAnatomy(projectId);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { rows: unknown[] } };
    expect(json.data.rows).toEqual([]);
  });

  it("folds ticket+comments+findings into TICKET and `other` into SYSTEM", async () => {
    const agentId = makeAgent("Opus Builder", null);
    makeSession({
      agentId,
      agentName: "Opus Builder",
      agentType: "build",
      createdAt: "2026-08-01T10:00:00.000Z",
    });

    const [row] = await rowsOf(projectId);
    expect(row.segments.ticket).toBe(4000 + 900 + 900);
    expect(row.segments.system).toBe(1000 + 300);
    expect(row.segments.spec).toBe(3100);
    expect(row.segments.memory).toBe(1100);
    expect(row.segments.docs).toBe(2400);
  });

  it("totals the six segments rather than trusting the stored estimatedPromptTokens", async () => {
    const agentId = makeAgent("Opus Builder", null);
    makeSession({
      agentId,
      agentName: "Opus Builder",
      agentType: "build",
      createdAt: "2026-08-01T10:00:00.000Z",
      estimatedPromptTokens: 999_999,
    });

    const [row] = await rowsOf(projectId);
    const sum = Object.values(row.segments).reduce((a, b) => a + b, 0);
    expect(row.total).toBe(sum);
    expect(row.total).not.toBe(999_999);
  });

  it("adds a PERSONA segment computed from named_agents.persona_prompt", async () => {
    const persona = "Tu es un builder méticuleux. Tu ne casses jamais les tests.";
    const agentId = makeAgent("Opus Builder", persona);
    makeSession({
      agentId,
      agentName: "Opus Builder",
      agentType: "build",
      createdAt: "2026-08-01T10:00:00.000Z",
    });

    const [row] = await rowsOf(projectId);
    expect(row.segments.persona).toBe(estimateTokens(personaSection(persona)));
    expect(row.segments.persona).toBeGreaterThan(0);
  });

  it("emits a zero PERSONA — so the band draws no segment — when the agent has none", async () => {
    const agentId = makeAgent("Opus Builder", null);
    makeSession({
      agentId,
      agentName: "Opus Builder",
      agentType: "build",
      createdAt: "2026-08-01T10:00:00.000Z",
    });

    const [row] = await rowsOf(projectId);
    expect(row.segments.persona).toBe(0);
  });

  it("derives BUG FIX from the epic type, BUILD otherwise, and REVIEW from a review_* type", async () => {
    const builder = makeAgent("Opus Builder", null);
    const codex = makeAgent("Codex Fast", null);
    const security = makeAgent("Security CC", null);

    makeSession({
      agentId: builder,
      agentName: "Opus Builder",
      agentType: "build",
      epicId: makeEpic(projectId, "feature"),
      createdAt: "2026-08-01T10:00:00.000Z",
    });
    makeSession({
      agentId: codex,
      agentName: "Codex Fast",
      agentType: "build",
      epicId: makeEpic(projectId, "bug"),
      createdAt: "2026-08-01T09:00:00.000Z",
    });
    makeSession({
      agentId: security,
      agentName: "Security CC",
      agentType: "review_security",
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    const rows = await rowsOf(projectId);
    const roleOf = (name: string) =>
      rows.find((row) => row.agentName === name)?.role;

    expect(roleOf("Opus Builder")).toBe("BUILD");
    expect(roleOf("Codex Fast")).toBe("BUG FIX");
    expect(roleOf("Security CC")).toBe("REVIEW");
  });

  it("maps merge / chat families onto their roles and uppercases anything else", async () => {
    makeSession({
      agentName: "Merger",
      agentType: "merge",
      createdAt: "2026-08-01T10:00:00.000Z",
    });
    makeSession({
      agentName: "Chatter",
      agentType: "spec_generation",
      createdAt: "2026-08-01T09:00:00.000Z",
    });
    makeSession({
      agentName: "Dreamer",
      agentType: "memory_distill",
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    const rows = await rowsOf(projectId);
    const roleOf = (name: string) =>
      rows.find((row) => row.agentName === name)?.role;

    expect(roleOf("Merger")).toBe("MERGE FIX");
    expect(roleOf("Chatter")).toBe("CHAT & SPEC");
    expect(roleOf("Dreamer")).toBe("MEMORY DISTILL");
  });

  it("keeps only the most recent session of each (agent, role) pair", async () => {
    const agentId = makeAgent("Opus Builder", null);
    makeSession({
      agentId,
      agentName: "Opus Builder",
      agentType: "build",
      createdAt: "2026-08-01T08:00:00.000Z",
      breakdown: { ...FULL_BREAKDOWN, spec: 10 },
    });
    const newest = makeSession({
      agentId,
      agentName: "Opus Builder",
      agentType: "build",
      createdAt: "2026-08-02T08:00:00.000Z",
      breakdown: { ...FULL_BREAKDOWN, spec: 5000 },
    });

    const rows = await rowsOf(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe(newest);
    expect(rows[0].segments.spec).toBe(5000);
  });

  it("keeps one row per role for the same agent", async () => {
    const agentId = makeAgent("Opus Builder", null);
    makeSession({
      agentId,
      agentName: "Opus Builder",
      agentType: "build",
      createdAt: "2026-08-02T08:00:00.000Z",
    });
    makeSession({
      agentId,
      agentName: "Opus Builder",
      agentType: "review_code",
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    const rows = await rowsOf(projectId);
    expect(rows.map((row) => row.role).sort()).toEqual(["BUILD", "REVIEW"]);
  });

  it("skips a row whose stored breakdown is unparsable, without throwing", async () => {
    makeSession({
      agentName: "Broken",
      agentType: "build",
      createdAt: "2026-08-02T08:00:00.000Z",
      rawBreakdown: "{not json at all",
    });
    makeSession({
      agentName: "Healthy",
      agentType: "build",
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    const rows = await rowsOf(projectId);
    expect(rows.map((row) => row.agentName)).toEqual(["Healthy"]);
  });

  it("skips an all-zero breakdown rather than drawing a row of zeros", async () => {
    makeSession({
      agentName: "Empty",
      agentType: "build",
      createdAt: "2026-08-02T08:00:00.000Z",
      breakdown: {
        spec: 0,
        memory: 0,
        ticket: 0,
        comments: 0,
        findings: 0,
        documents: 0,
        system: 0,
        other: 0,
      },
    });

    expect(await rowsOf(projectId)).toEqual([]);
  });

  it("annotates the ticket segment with the epic's story count, and pluralises it", async () => {
    const epicMany = makeEpic(projectId, "feature");
    const epicOne = makeEpic(projectId, "feature");
    const epicNone = makeEpic(projectId, "feature");
    for (let i = 0; i < 5; i += 1) {
      db.insert(userStories)
        .values({ id: `story-${nanoid(6)}`, epicId: epicMany, title: `S${i}` })
        .run();
    }
    db.insert(userStories)
      .values({ id: `story-${nanoid(6)}`, epicId: epicOne, title: "Only" })
      .run();

    makeSession({
      agentName: "Many",
      agentType: "build",
      epicId: epicMany,
      createdAt: "2026-08-03T08:00:00.000Z",
    });
    makeSession({
      agentName: "One",
      agentType: "build",
      epicId: epicOne,
      createdAt: "2026-08-02T08:00:00.000Z",
    });
    makeSession({
      agentName: "None",
      agentType: "build",
      epicId: epicNone,
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    const rows = await rowsOf(projectId);
    const annotationOf = (name: string) =>
      rows.find((row) => row.agentName === name)?.annotations;

    expect(annotationOf("Many")?.ticket).toBe("epic + 5 stories");
    expect(annotationOf("One")?.ticket).toBe("epic + 1 story");
    expect(annotationOf("None")?.ticket).toBeUndefined();
  });

  it("annotates a review row's system segment with the rubric, and nothing else", async () => {
    makeSession({
      agentName: "Security CC",
      agentType: "review_security",
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    const [row] = await rowsOf(projectId);
    expect(row.annotations.system).toBe("review rubric");
    // The frame's `diff +229 −18` needs a live worktree diffstat this route
    // cannot reach — no annotation is ever fabricated.
    expect(JSON.stringify(row.annotations)).not.toContain("diff");
  });

  it("never fabricates a `bug + repro` annotation for a bug row", async () => {
    makeSession({
      agentName: "Codex Fast",
      agentType: "build",
      epicId: makeEpic(projectId, "bug"),
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    const [row] = await rowsOf(projectId);
    expect(row.role).toBe("BUG FIX");
    expect(JSON.stringify(row.annotations)).not.toContain("repro");
  });

  it("returns at most six rows, ranked by total descending", async () => {
    for (let i = 0; i < 9; i += 1) {
      makeSession({
        agentName: `Agent ${i}`,
        agentType: "build",
        createdAt: `2026-08-0${(i % 9) + 1}T08:00:00.000Z`,
        breakdown: { ...FULL_BREAKDOWN, spec: 100 * (i + 1) },
      });
    }

    const rows = await rowsOf(projectId);
    expect(rows).toHaveLength(6);
    const totals = rows.map((row) => row.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expect(rows[0].agentName).toBe("Agent 8");
  });

  it("ignores sessions belonging to another project", async () => {
    const other = makeProject();
    makeSession({
      project: other,
      agentName: "Foreign",
      agentType: "build",
      createdAt: "2026-08-01T08:00:00.000Z",
    });

    expect(await rowsOf(projectId)).toEqual([]);
  });

  it("does not cache", async () => {
    const res = await getAnatomy(projectId);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
