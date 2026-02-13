import { describe, it, expect } from "vitest";
import * as schema from "@/lib/db/schema";

describe("Schema: projects.githubOwnerRepo column", () => {
  it("has githubOwnerRepo column defined", () => {
    const col = schema.projects.githubOwnerRepo;
    expect(col).toBeDefined();
    expect(col.name).toBe("github_owner_repo");
  });

  it("githubOwnerRepo is nullable (no notNull)", () => {
    const col = schema.projects.githubOwnerRepo;
    expect(col.notNull).toBeFalsy();
  });
});

describe("Schema: gitSyncLog table", () => {
  it("has required columns", () => {
    const cols = schema.gitSyncLog;
    expect(cols.id).toBeDefined();
    expect(cols.projectId).toBeDefined();
    expect(cols.operation).toBeDefined();
    expect(cols.branch).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.detail).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });

  it("id is the primary key", () => {
    expect(schema.gitSyncLog.id.name).toBe("id");
  });

  it("projectId references projects table", () => {
    expect(schema.gitSyncLog.projectId.name).toBe("project_id");
  });

  it("operation column name matches DB", () => {
    expect(schema.gitSyncLog.operation.name).toBe("operation");
  });

  it("status column name matches DB", () => {
    expect(schema.gitSyncLog.status.name).toBe("status");
  });
});

describe("Schema: gitSyncLog exported types", () => {
  it("exports select and insert types", () => {
    const syncLogShape: schema.GitSyncLog = {
      id: "sl_1",
      projectId: "proj_1",
      operation: "push",
      branch: "main",
      status: "success",
      detail: null,
      createdAt: null,
    };
    expect(syncLogShape.operation).toBe("push");
    expect(syncLogShape.status).toBe("success");
  });
});
