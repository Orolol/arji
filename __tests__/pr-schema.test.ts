import { describe, it, expect } from "vitest";
import * as schema from "@/lib/db/schema";

describe("Schema: epics PR fields", () => {
  it("has prNumber column", () => {
    const col = schema.epics.prNumber;
    expect(col).toBeDefined();
    expect(col.name).toBe("pr_number");
  });

  it("has prUrl column", () => {
    const col = schema.epics.prUrl;
    expect(col).toBeDefined();
    expect(col.name).toBe("pr_url");
  });

  it("has prStatus column", () => {
    const col = schema.epics.prStatus;
    expect(col).toBeDefined();
    expect(col.name).toBe("pr_status");
  });

  it("PR fields are nullable", () => {
    expect(schema.epics.prNumber.notNull).toBeFalsy();
    expect(schema.epics.prUrl.notNull).toBeFalsy();
    expect(schema.epics.prStatus.notNull).toBeFalsy();
  });
});

describe("Schema: pullRequests table", () => {
  it("has all required columns", () => {
    const cols = schema.pullRequests;
    expect(cols.id).toBeDefined();
    expect(cols.projectId).toBeDefined();
    expect(cols.epicId).toBeDefined();
    expect(cols.number).toBeDefined();
    expect(cols.url).toBeDefined();
    expect(cols.title).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.headBranch).toBeDefined();
    expect(cols.baseBranch).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("id is the primary key", () => {
    expect(schema.pullRequests.id.name).toBe("id");
  });

  it("column names match DB schema", () => {
    expect(schema.pullRequests.projectId.name).toBe("project_id");
    expect(schema.pullRequests.epicId.name).toBe("epic_id");
    expect(schema.pullRequests.number.name).toBe("number");
    expect(schema.pullRequests.url.name).toBe("url");
    expect(schema.pullRequests.title.name).toBe("title");
    expect(schema.pullRequests.status.name).toBe("status");
    expect(schema.pullRequests.headBranch.name).toBe("head_branch");
    expect(schema.pullRequests.baseBranch.name).toBe("base_branch");
  });

  it("status defaults to open", () => {
    const col = schema.pullRequests.status;
    expect(col.default).toBe("open");
  });

  it("baseBranch defaults to main", () => {
    const col = schema.pullRequests.baseBranch;
    expect(col.default).toBe("main");
  });
});

describe("Schema: pullRequests exported types", () => {
  it("PullRequest select type works correctly", () => {
    const pr: schema.PullRequest = {
      id: "pr_1",
      projectId: "proj_1",
      epicId: "epic_1",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      title: "feat: add feature",
      status: "open",
      headBranch: "feature/my-branch",
      baseBranch: "main",
      createdAt: null,
      updatedAt: null,
    };
    expect(pr.number).toBe(42);
    expect(pr.status).toBe("open");
  });
});
