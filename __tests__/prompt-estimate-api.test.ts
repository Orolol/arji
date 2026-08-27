import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/projects/[projectId]/prompt-estimate/route";
import { db } from "@/lib/db";
import { epics, projects, settings, ticketComments, userStories } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { promptTokenBudgetSettingKey } from "@/lib/tokens/budget";

describe("Prompt Estimate API Route", () => {
  it("estimates tokens for an epic build prompt and checks budget", async () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Test Project",
        spec: "# Specification\nDetailed requirements for testing.",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Test Epic",
        description: "Test Epic Description",
        status: "todo",
      })
      .run();

    db.insert(userStories)
      .values({
        id: `story-${nanoid(6)}`,
        epicId,
        title: "User Story 1",
        description: "Story Description",
        acceptanceCriteria: "- Criterion 1\n- Criterion 2",
        status: "todo",
      })
      .run();

    const req = new NextRequest(
      `http://localhost/api/projects/${projectId}/prompt-estimate?epicId=${epicId}&dispatchType=build`
    );

    const res = await GET(req, {
      params: Promise.resolve({ projectId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data.total).toBeGreaterThan(0);
    expect(json.data.breakdown.spec).toBeGreaterThan(0);
    expect(json.data.breakdown.ticket).toBeGreaterThan(0);
    expect(json.data.budgetExceeded).toBe(false);
  });

  it("warns when budget is exceeded and identifies largest section via POST", async () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Heavy Project",
        spec: "# Huge Spec\n" + "Very long specification content. ".repeat(100),
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Epic Title",
        description: "Short description",
        status: "todo",
      })
      .run();

    // Set a tiny budget for this project (e.g. 50 tokens)
    db.insert(settings)
      .values({
        key: promptTokenBudgetSettingKey(projectId),
        value: "50",
      })
      .run();

    const req = new NextRequest(
      `http://localhost/api/projects/${projectId}/prompt-estimate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          epicId,
          dispatchType: "build",
          comment: "Extra comment",
        }),
      }
    );

    const res = await POST(req, {
      params: Promise.resolve({ projectId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.budgetExceeded).toBe(true);
    expect(json.data.budget).toBe(50);
    expect(json.data.largestSection).toBeDefined();
    expect(json.data.largestSection.key).toBe("spec");
    expect(json.data.largestSection.tokens).toBeGreaterThan(50);
  });

  it("correctly prices multi-type review dispatches across all sessions", async () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;
    const storyId = `story-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Review Project",
        spec: "Spec content",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Epic",
        status: "review",
      })
      .run();

    db.insert(userStories)
      .values({
        id: storyId,
        epicId,
        title: "Review Story",
        description: "Story to review",
        acceptanceCriteria: "Pass all review checks",
        status: "review",
      })
      .run();

    const req = new NextRequest(
      `http://localhost/api/projects/${projectId}/prompt-estimate?epicId=${epicId}&storyId=${storyId}&dispatchType=review&reviewTypes=security,code_review`
    );

    const res = await GET(req, {
      params: Promise.resolve({ projectId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.sessionsCount).toBe(2);
    expect(json.data.perSessionEstimates).toHaveLength(2);
    expect(json.data.perSessionEstimates[0].reviewType).toBe("security");
    expect(json.data.perSessionEstimates[1].reviewType).toBe("code_review");

    const expectedTotal =
      json.data.perSessionEstimates[0].tokens +
      json.data.perSessionEstimates[1].tokens;
    expect(json.data.total).toBe(expectedTotal);
  });

  it("estimates story grading without throwing", async () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;
    const storyId = `story-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Grading Project",
        spec: "Spec content",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Grading Epic",
        status: "review",
      })
      .run();

    db.insert(userStories)
      .values({
        id: storyId,
        epicId,
        title: "Story to Grade",
        description: "Story desc",
        acceptanceCriteria: "- Must satisfy criterion A\n- Must satisfy criterion B",
        status: "review",
      })
      .run();

    const req = new NextRequest(
      `http://localhost/api/projects/${projectId}/prompt-estimate?epicId=${epicId}&storyId=${storyId}&dispatchType=grading`
    );

    const res = await GET(req, {
      params: Promise.resolve({ projectId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.total).toBeGreaterThan(0);
    expect(json.data.breakdown.findings).toBeGreaterThan(0);
  });

  it("estimates epic grading across all stories", async () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Epic Grading Project",
        spec: "Spec content",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Epic to Grade",
        status: "review",
      })
      .run();

    db.insert(userStories)
      .values({
        id: `story-${nanoid(6)}`,
        epicId,
        title: "Story 1",
        acceptanceCriteria: "- AC 1",
        status: "review",
      })
      .run();

    db.insert(userStories)
      .values({
        id: `story-${nanoid(6)}`,
        epicId,
        title: "Story 2",
        acceptanceCriteria: "- AC 2",
        status: "review",
      })
      .run();

    const req = new NextRequest(
      `http://localhost/api/projects/${projectId}/prompt-estimate?epicId=${epicId}&dispatchType=grading`
    );

    const res = await GET(req, {
      params: Promise.resolve({ projectId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.total).toBeGreaterThan(0);
    expect(json.data.breakdown.findings).toBeGreaterThan(0);
  });

  it("attributes a comment containing markdown headings to comments and NOT findings", async () => {
    const projectId = `proj-${nanoid(6)}`;
    const epicId = `epic-${nanoid(6)}`;

    db.insert(projects)
      .values({
        id: projectId,
        name: "Comment Heading Project",
        spec: "Spec",
      })
      .run();

    db.insert(epics)
      .values({
        id: epicId,
        projectId,
        title: "Epic with Review Comment",
        status: "in_progress",
      })
      .run();

    const reviewReportBody =
      "## Code Review Checklist\n\n- [x] Item 1\n- [x] Item 2\n\n```typescript\nconst x = 1;\n```\n";

    db.insert(ticketComments)
      .values({
        id: `comm-${nanoid(6)}`,
        epicId,
        author: "agent",
        content: reviewReportBody,
        createdAt: new Date().toISOString(),
      })
      .run();

    const req = new NextRequest(
      `http://localhost/api/projects/${projectId}/prompt-estimate?epicId=${epicId}&dispatchType=build`
    );

    const res = await GET(req, {
      params: Promise.resolve({ projectId }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.breakdown.comments).toBeGreaterThan(0);
    // Findings should only contain findings from the build prompt (empty if no open reviewComments table findings and not bug)
    expect(json.data.breakdown.findings).toBe(0);
  });
});
