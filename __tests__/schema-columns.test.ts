import { describe, it, expect } from "vitest";
import * as schema from "@/lib/db/schema";

describe("Schema: agentSessions columns", () => {
  it("has orchestrationMode column with default 'solo'", () => {
    const col = schema.agentSessions.orchestrationMode;
    expect(col).toBeDefined();
    expect(col.name).toBe("orchestration_mode");
    expect(col.default).toBe("solo");
  });

  it("has provider column with default 'claude-code'", () => {
    const col = schema.agentSessions.provider;
    expect(col).toBeDefined();
    expect(col.name).toBe("provider");
    expect(col.default).toBe("claude-code");
  });
});

describe("Schema: chatConversations columns", () => {
  it("has provider column with default 'claude-code'", () => {
    const col = schema.chatConversations.provider;
    expect(col).toBeDefined();
    expect(col.name).toBe("provider");
    expect(col.default).toBe("claude-code");
  });
});

describe("Schema: existing columns preserved", () => {
  it("agentSessions still has all original columns", () => {
    const cols = schema.agentSessions;
    expect(cols.id).toBeDefined();
    expect(cols.projectId).toBeDefined();
    expect(cols.epicId).toBeDefined();
    expect(cols.userStoryId).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.mode).toBeDefined();
    expect(cols.prompt).toBeDefined();
    expect(cols.logsPath).toBeDefined();
    expect(cols.branchName).toBeDefined();
    expect(cols.worktreePath).toBeDefined();
    expect(cols.startedAt).toBeDefined();
    expect(cols.completedAt).toBeDefined();
    expect(cols.error).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });

  it("chatConversations still has all original columns", () => {
    const cols = schema.chatConversations;
    expect(cols.id).toBeDefined();
    expect(cols.projectId).toBeDefined();
    expect(cols.type).toBeDefined();
    expect(cols.label).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.epicId).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });
});
