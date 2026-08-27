import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { agentSessions, epics, projects, userStories } from "@/lib/db/schema";
import { createQueuedSession } from "@/lib/agent-sessions/lifecycle";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { buildBuildPrompt, buildReviewPrompt } from "@/lib/claude/prompt-builder";

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
    expect(session?.estimatedPromptBreakdown).not.toBeNull();

    const breakdown = JSON.parse(session!.estimatedPromptBreakdown!);
    expect(breakdown.spec).toBeGreaterThan(0);
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
    expect(session?.estimatedPromptBreakdown).not.toBeNull();

    const breakdown = JSON.parse(session!.estimatedPromptBreakdown!);
    expect(breakdown.findings).toBeGreaterThan(0);
    expect(breakdown.ticket).toBeGreaterThan(0);
  });
});
