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
  it("projects has githubOwnerRepo column", () => {
    const col = schema.projects.githubOwnerRepo;
    expect(col).toBeDefined();
    expect(col.name).toBe("github_owner_repo");
  });

  it("gitSyncLog has operation/status/detail columns", () => {
    const cols = schema.gitSyncLog;
    expect(cols.projectId).toBeDefined();
    expect(cols.operation.name).toBe("operation");
    expect(cols.status.name).toBe("status");
    expect(cols.detail.name).toBe("detail");
    expect(cols.branch.name).toBe("branch");
  });

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
    expect(cols.endedAt).toBeDefined();
    expect(cols.completedAt).toBeDefined();
    expect(cols.lastNonEmptyText).toBeDefined();
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

describe("Schema: session chunk tables", () => {
  it("has agentSessionSequences table columns", () => {
    const cols = schema.agentSessionSequences;
    expect(cols.sessionId).toBeDefined();
    expect(cols.nextSequence).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("has agentSessionChunks table columns", () => {
    const cols = schema.agentSessionChunks;
    expect(cols.id).toBeDefined();
    expect(cols.sessionId).toBeDefined();
    expect(cols.streamType).toBeDefined();
    expect(cols.sequence).toBeDefined();
    expect(cols.chunkKey).toBeDefined();
    expect(cols.content).toBeDefined();
    expect(cols.createdAt).toBeDefined();
  });

  it("has uniqueness constraints for session+sequence and stream+key", () => {
    const extraConfig =
      schema.agentSessionChunks[Symbol.for("drizzle:ExtraConfigBuilder")](
        schema.agentSessionChunks
      );
    expect(extraConfig.sessionSequenceUnique).toBeDefined();
    expect(extraConfig.sessionStreamKeyUnique).toBeDefined();
  });
});

describe("Schema: agentPrompts table", () => {
  it("has required columns", () => {
    const cols = schema.agentPrompts;
    expect(cols.id).toBeDefined();
    expect(cols.agentType).toBeDefined();
    expect(cols.systemPrompt).toBeDefined();
    expect(cols.scope).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("has unique constraint on agentType + scope", () => {
    const extraConfig = schema.agentPrompts[Symbol.for("drizzle:ExtraConfigBuilder")](
      schema.agentPrompts
    );
    expect(extraConfig.agentTypeScopeUnique).toBeDefined();
    expect(extraConfig.agentTypeScopeUnique.config.columns).toHaveLength(2);
  });
});

describe("Schema: customReviewAgents table", () => {
  it("has required columns", () => {
    const cols = schema.customReviewAgents;
    expect(cols.id).toBeDefined();
    expect(cols.name).toBeDefined();
    expect(cols.systemPrompt).toBeDefined();
    expect(cols.scope).toBeDefined();
    expect(cols.position).toBeDefined();
    expect(cols.isEnabled).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("has unique constraint on name + scope", () => {
    const extraConfig =
      schema.customReviewAgents[Symbol.for("drizzle:ExtraConfigBuilder")](
        schema.customReviewAgents
      );
    expect(extraConfig.nameScopeUnique).toBeDefined();
    expect(extraConfig.nameScopeUnique.config.columns).toHaveLength(2);
  });
});

describe("Schema: agentProviderDefaults table", () => {
  it("has required columns", () => {
    const cols = schema.agentProviderDefaults;
    expect(cols.id).toBeDefined();
    expect(cols.agentType).toBeDefined();
    expect(cols.provider).toBeDefined();
    expect(cols.scope).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it("has unique constraint on agentType + scope", () => {
    const extraConfig =
      schema.agentProviderDefaults[Symbol.for("drizzle:ExtraConfigBuilder")](
        schema.agentProviderDefaults
      );
    expect(extraConfig.agentTypeScopeUnique).toBeDefined();
    expect(extraConfig.agentTypeScopeUnique.config.columns).toHaveLength(2);
  });
});

describe("Schema: exported types", () => {
  it("exports select and insert types for new tables", () => {
    const agentPromptShape: schema.AgentPrompt = {
      id: "ap_1",
      agentType: "build",
      systemPrompt: "Prompt",
      scope: "global",
      createdAt: null,
      updatedAt: null,
    };
    const customReviewAgentShape: schema.CustomReviewAgent = {
      id: "cra_1",
      name: "UI Review",
      systemPrompt: "Review UI details",
      scope: "global",
      position: 0,
      isEnabled: 1,
      createdAt: null,
      updatedAt: null,
    };
    const agentProviderDefaultShape: schema.AgentProviderDefault = {
      id: "apd_1",
      agentType: "build",
      provider: "claude-code",
      scope: "global",
      createdAt: null,
      updatedAt: null,
    };

    expect(agentPromptShape.agentType).toBe("build");
    expect(customReviewAgentShape.name).toBe("UI Review");
    expect(agentProviderDefaultShape.provider).toBe("claude-code");
  });
});
