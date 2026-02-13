import { describe, it, expect } from "vitest";
import * as schema from "@/lib/db/schema";

describe("Schema: epics PR columns", () => {
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
});

describe("Schema: projects githubOwnerRepo column", () => {
  it("has githubOwnerRepo column", () => {
    const col = schema.projects.githubOwnerRepo;
    expect(col).toBeDefined();
    expect(col.name).toBe("github_owner_repo");
  });
});

describe("Schema: pullRequests table", () => {
  it("has all required columns", () => {
    const cols = schema.pullRequests;
    expect(cols.id).toBeDefined();
    expect(cols.projectId).toBeDefined();
    expect(cols.epicId).toBeDefined();
    expect(cols.prNumber).toBeDefined();
    expect(cols.title).toBeDefined();
    expect(cols.body).toBeDefined();
    expect(cols.htmlUrl).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.headBranch).toBeDefined();
    expect(cols.baseBranch).toBeDefined();
    expect(cols.githubId).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("has correct column names", () => {
    expect(schema.pullRequests.prNumber.name).toBe("pr_number");
    expect(schema.pullRequests.htmlUrl.name).toBe("html_url");
    expect(schema.pullRequests.headBranch.name).toBe("head_branch");
    expect(schema.pullRequests.baseBranch.name).toBe("base_branch");
    expect(schema.pullRequests.githubId.name).toBe("github_id");
  });
});

describe("Schema: gitSyncLog table", () => {
  it("has all required columns", () => {
    const cols = schema.gitSyncLog;
    expect(cols.id).toBeDefined();
    expect(cols.projectId).toBeDefined();
    expect(cols.operation).toBeDefined();
    expect(cols.branch).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.detail).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });
});

describe("Schema: PR-related exported types", () => {
  it("exports PullRequest type", () => {
    const pr: schema.PullRequest = {
      id: "pr-1",
      projectId: "proj-1",
      epicId: "epic-1",
      prNumber: 42,
      title: "Add feature",
      body: "Description",
      htmlUrl: "https://github.com/org/repo/pull/42",
      status: "open",
      headBranch: "feature/test",
      baseBranch: "main",
      githubId: 12345,
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    };
    expect(pr.prNumber).toBe(42);
  });

  it("exports GitSyncLogEntry type", () => {
    const entry: schema.GitSyncLogEntry = {
      id: "log-1",
      projectId: "proj-1",
      operation: "pr_create",
      branch: "feature/test",
      status: "success",
      detail: '{"prNumber": 42}',
      createdAt: "2025-01-01",
    };
    expect(entry.operation).toBe("pr_create");
  });
});
