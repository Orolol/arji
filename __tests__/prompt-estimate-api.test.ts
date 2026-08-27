import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/projects/[projectId]/prompt-estimate/route";
import { db } from "@/lib/db";
import { epics, projects, settings, userStories } from "@/lib/db/schema";
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
        projectId,
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

  it("estimates review prompt for a story", async () => {
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
        projectId,
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
    expect(json.data.total).toBeGreaterThan(0);
    expect(json.data.breakdown.findings).toBeGreaterThan(0);
  });
});
