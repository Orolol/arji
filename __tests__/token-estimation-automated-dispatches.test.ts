import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { agentSessions, epics, projects } from "@/lib/db/schema";
import { createQueuedSession } from "@/lib/agent-sessions/lifecycle";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { buildBuildPrompt, buildReviewPrompt } from "@/lib/claude/prompt-builder";
import { assembleEpicBuildPrompt } from "@/lib/tokens/dispatch-prompt";

describe("Token Estimation in Automated Dispatches", () => {
  it("persists estimated prompt tokens for pipeline and automated build sessions", () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Auto Pipeline Project",
        spec: "# Spec\nFull specification for the autonomous pipeline run.",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Auto Epic",
        description: "Epic description",
        status: "in_progress",
      })
      .run();

    const prompt = buildBuildPrompt(
      { name: "Auto Pipeline Project", spec: "# Spec\nFull specification." },
      [],
      { title: "Auto Epic", description: "Epic description" },
      [],
      "System prompt"
    );

    const sessionId = `sess-${nanoid(6)}`;
    const batchRunId = `night_${nanoid(8)}`;

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId,
      mode: "code",
      provider: "claude-code",
      agentType: "build",
      prompt,
      batchRunId,
    });

    const session = db
      .select({
        id: agentSessions.id,
        batchRunId: agentSessions.batchRunId,
        estimatedPromptTokens: agentSessions.estimatedPromptTokens,
        estimatedPromptBreakdown: agentSessions.estimatedPromptBreakdown,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();

    expect(session).toBeDefined();
    expect(session?.batchRunId).toBe(batchRunId);
    expect(session?.estimatedPromptTokens).toBeGreaterThan(0);
    expect(session?.estimatedPromptTokens).toBe(Math.ceil(prompt.length / 4));
    expect(session?.estimatedPromptBreakdown).toBeNull();
  });

  it("persists estimated prompt tokens for Full Auto and review sessions", () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Full Auto Project",
        spec: "# Full Auto Spec\nSpecification details.",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Review Epic",
        status: "review",
      })
      .run();

    const prompt = buildReviewPrompt(
      { name: "Full Auto Project", spec: "Spec" },
      [],
      { title: "Review Epic" },
      { title: "Story", description: "Desc", acceptanceCriteria: "AC" },
      "code_review",
      "System prompt"
    );

    const sessionId = `sess-${nanoid(6)}`;

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId,
      mode: "code",
      provider: "claude-code",
      agentType: "review_code",
      prompt,
    });

    const session = db
      .select({
        id: agentSessions.id,
        estimatedPromptTokens: agentSessions.estimatedPromptTokens,
        estimatedPromptBreakdown: agentSessions.estimatedPromptBreakdown,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();

    expect(session).toBeDefined();
    expect(session?.estimatedPromptTokens).toBeGreaterThan(0);
    expect(session?.estimatedPromptBreakdown).toBeNull();
  });

  it("persists exact by-construction breakdown when a comment contains markdown headings", async () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Comment Heading Persist Project",
        spec: "# Spec\nSpecification.",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Build Epic with Review Report Comment",
        status: "in_progress",
      })
      .run();

    const reviewReportComment =
      "## Code Review Checklist\n\n- [x] Item 1\n- [x] Item 2\n\n```typescript\nconst x = 42;\n```\n";

    const assembled = await assembleEpicBuildPrompt({
      projectId,
      epicId,
      project: { name: "Comment Heading Persist Project", spec: "# Spec\nSpecification." },
      epic: { title: "Build Epic with Review Report Comment" },
      comment: reviewReportComment,
    });

    const sessionId = `sess-${nanoid(6)}`;

    createQueuedSession({
      id: sessionId,
      projectId,
      epicId,
      mode: "code",
      provider: "claude-code",
      agentType: "build",
      prompt: assembled.prompt,
      estimatedPromptTokens: assembled.tokens.total,
      estimatedPromptBreakdown: JSON.stringify(assembled.tokens.breakdown),
    });

    const session = db
      .select({
        id: agentSessions.id,
        estimatedPromptTokens: agentSessions.estimatedPromptTokens,
        estimatedPromptBreakdown: agentSessions.estimatedPromptBreakdown,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();

    expect(session).toBeDefined();
    const breakdown = JSON.parse(session!.estimatedPromptBreakdown!);
    expect(breakdown.comments).toBeGreaterThan(0);
    expect(breakdown.findings).toBe(0);

    const sum = Object.values(breakdown as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - session!.estimatedPromptTokens!)).toBeLessThanOrEqual(8);
  });
});
