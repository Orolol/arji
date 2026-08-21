/**
 * Authoritative, table-driven spec for the Drizzle schema in `lib/db/schema.ts`.
 *
 * This file replaces nine overlapping per-feature schema tests
 * (github-schema, github-issues-schema, github-release-schema,
 * github-releases-schema, notifications-schema, schema-columns,
 * schema-pr-tables, pr-schema, review-comments-schema). Each Drizzle table gets
 * exactly ONE column block here, so drift shows up in a single place.
 *
 * Structure:
 *  1. COLUMNS — every exported table's full column set (JS key -> SQL name).
 *  2. DEFAULTS / NOT NULL / NULLABLE — column-level metadata.
 *  3. INDEXES & UNIQUE CONSTRAINTS — declared via drizzle's extra config.
 *  4. FOREIGN KEYS — reference targets and ON DELETE behaviour.
 *  5. EXPORTED TYPES — compile-time shape checks on `$inferSelect` aliases.
 *  6. MIGRATED DATABASE — behaviour verified against a real migrated SQLite DB.
 */
import { describe, it, expect } from "vitest";
import { getTableName, is } from "drizzle-orm";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/lib/db/schema";
import { createTestDb } from "@/lib/db/test-utils";

type ColumnSpec = Record<string, string>;

/**
 * Expected column set for every table exported by the schema, keyed by the
 * schema export name. Values map the JS property name to the SQL column name.
 * The set is asserted exactly: adding or renaming a column in `schema.ts`
 * without updating this map fails the suite.
 */
const TABLE_COLUMNS: Record<string, { sqlName: string; columns: ColumnSpec }> = {
  projects: {
    sqlName: "projects",
    columns: {
      id: "id",
      name: "name",
      description: "description",
      status: "status",
      gitRepoPath: "git_repo_path",
      githubOwnerRepo: "github_owner_repo",
      cloneSource: "clone_source",
      gitRemoteUrl: "git_remote_url",
      defaultBranch: "default_branch",
      spec: "spec",
      imported: "imported",
      ticketCounter: "ticket_counter",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  documents: {
    sqlName: "documents",
    columns: {
      id: "id",
      projectId: "project_id",
      originalFilename: "original_filename",
      kind: "kind",
      markdownContent: "markdown_content",
      imagePath: "image_path",
      mimeType: "mime_type",
      sizeBytes: "size_bytes",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  epics: {
    sqlName: "epics",
    columns: {
      id: "id",
      projectId: "project_id",
      title: "title",
      description: "description",
      priority: "priority",
      status: "status",
      position: "position",
      branchName: "branch_name",
      prNumber: "pr_number",
      prUrl: "pr_url",
      prStatus: "pr_status",
      confidence: "confidence",
      evidence: "evidence",
      createdAt: "created_at",
      updatedAt: "updated_at",
      type: "type",
      linkedEpicId: "linked_epic_id",
      images: "images",
      readableId: "readable_id",
      githubIssueNumber: "github_issue_number",
      githubIssueUrl: "github_issue_url",
      githubIssueState: "github_issue_state",
      releaseId: "release_id",
    },
  },
  userStories: {
    sqlName: "user_stories",
    columns: {
      id: "id",
      epicId: "epic_id",
      title: "title",
      description: "description",
      acceptanceCriteria: "acceptance_criteria",
      status: "status",
      position: "position",
      createdAt: "created_at",
    },
  },
  chatConversations: {
    sqlName: "chat_conversations",
    columns: {
      id: "id",
      projectId: "project_id",
      type: "type",
      label: "label",
      status: "status",
      epicId: "epic_id",
      provider: "provider",
      claudeSessionId: "claude_session_id",
      cliSessionId: "cli_session_id",
      namedAgentId: "named_agent_id",
      createdAt: "created_at",
    },
  },
  chatMessages: {
    sqlName: "chat_messages",
    columns: {
      id: "id",
      projectId: "project_id",
      conversationId: "conversation_id",
      role: "role",
      content: "content",
      metadata: "metadata",
      createdAt: "created_at",
    },
  },
  chatAttachments: {
    sqlName: "chat_attachments",
    columns: {
      id: "id",
      chatMessageId: "chat_message_id",
      projectId: "project_id",
      epicId: "epic_id",
      fileName: "file_name",
      filePath: "file_path",
      mimeType: "mime_type",
      sizeBytes: "size_bytes",
      createdAt: "created_at",
    },
  },
  agentSessions: {
    sqlName: "agent_sessions",
    columns: {
      id: "id",
      projectId: "project_id",
      epicId: "epic_id",
      userStoryId: "user_story_id",
      status: "status",
      mode: "mode",
      orchestrationMode: "orchestration_mode",
      provider: "provider",
      prompt: "prompt",
      logsPath: "logs_path",
      branchName: "branch_name",
      worktreePath: "worktree_path",
      startedAt: "started_at",
      endedAt: "ended_at",
      completedAt: "completed_at",
      lastNonEmptyText: "last_non_empty_text",
      error: "error",
      outcome: "outcome",
      inputTokens: "input_tokens",
      outputTokens: "output_tokens",
      totalCostUsd: "total_cost_usd",
      batchRunId: "batch_run_id",
      claudeSessionId: "claude_session_id",
      cliSessionId: "cli_session_id",
      namedAgentId: "named_agent_id",
      agentType: "agent_type",
      namedAgentName: "named_agent_name",
      model: "model",
      cliCommand: "cli_command",
      createdAt: "created_at",
    },
  },
  agentSessionSequences: {
    sqlName: "agent_session_sequences",
    columns: {
      sessionId: "session_id",
      nextSequence: "next_sequence",
      updatedAt: "updated_at",
    },
  },
  agentSessionChunks: {
    sqlName: "agent_session_chunks",
    columns: {
      id: "id",
      sessionId: "session_id",
      streamType: "stream_type",
      sequence: "sequence",
      chunkKey: "chunk_key",
      content: "content",
      createdAt: "created_at",
    },
  },
  ticketComments: {
    sqlName: "ticket_comments",
    columns: {
      id: "id",
      userStoryId: "user_story_id",
      epicId: "epic_id",
      author: "author",
      content: "content",
      agentSessionId: "agent_session_id",
      createdAt: "created_at",
    },
  },
  releases: {
    sqlName: "releases",
    columns: {
      id: "id",
      projectId: "project_id",
      version: "version",
      title: "title",
      changelog: "changelog",
      epicIds: "epic_ids",
      releaseBranch: "release_branch",
      gitTag: "git_tag",
      githubReleaseId: "github_release_id",
      githubReleaseUrl: "github_release_url",
      pushedAt: "pushed_at",
      createdAt: "created_at",
    },
  },
  pullRequests: {
    sqlName: "pull_requests",
    columns: {
      id: "id",
      projectId: "project_id",
      epicId: "epic_id",
      number: "number",
      url: "url",
      title: "title",
      status: "status",
      headBranch: "head_branch",
      baseBranch: "base_branch",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  settings: {
    sqlName: "settings",
    columns: {
      key: "key",
      value: "value",
      updatedAt: "updated_at",
    },
  },
  agentPrompts: {
    sqlName: "agent_prompts",
    columns: {
      id: "id",
      agentType: "agent_type",
      systemPrompt: "system_prompt",
      scope: "scope",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  customReviewAgents: {
    sqlName: "custom_review_agents",
    columns: {
      id: "id",
      name: "name",
      systemPrompt: "system_prompt",
      scope: "scope",
      position: "position",
      isEnabled: "is_enabled",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  namedAgents: {
    sqlName: "named_agents",
    columns: {
      id: "id",
      name: "name",
      provider: "provider",
      model: "model",
      readableAgentName: "readable_agent_name",
      createdAt: "created_at",
    },
  },
  agentProviderDefaults: {
    sqlName: "agent_provider_defaults",
    columns: {
      id: "id",
      agentType: "agent_type",
      provider: "provider",
      namedAgentId: "named_agent_id",
      scope: "scope",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  ticketDependencies: {
    sqlName: "ticket_dependencies",
    columns: {
      id: "id",
      ticketId: "ticket_id",
      dependsOnTicketId: "depends_on_ticket_id",
      projectId: "project_id",
      scopeType: "scope_type",
      scopeId: "scope_id",
      createdAt: "created_at",
    },
  },
  reviewComments: {
    sqlName: "review_comments",
    columns: {
      id: "id",
      epicId: "epic_id",
      filePath: "file_path",
      lineNumber: "line_number",
      body: "body",
      author: "author",
      status: "status",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  gitSyncLog: {
    sqlName: "git_sync_log",
    columns: {
      id: "id",
      projectId: "project_id",
      operation: "operation",
      branch: "branch",
      status: "status",
      detail: "detail",
      createdAt: "created_at",
    },
  },
  githubIssues: {
    sqlName: "github_issues",
    columns: {
      id: "id",
      projectId: "project_id",
      issueNumber: "issue_number",
      title: "title",
      body: "body",
      labels: "labels",
      milestone: "milestone",
      assignees: "assignees",
      githubUrl: "github_url",
      createdAtGitHub: "created_at_github",
      updatedAtGitHub: "updated_at_github",
      syncedAt: "synced_at",
      importedEpicId: "imported_epic_id",
      importedAt: "imported_at",
    },
  },
  qaReports: {
    sqlName: "qa_reports",
    columns: {
      id: "id",
      projectId: "project_id",
      status: "status",
      agentSessionId: "agent_session_id",
      namedAgentId: "named_agent_id",
      promptUsed: "prompt_used",
      customPromptId: "custom_prompt_id",
      reportContent: "report_content",
      summary: "summary",
      checkType: "check_type",
      createdAt: "created_at",
      completedAt: "completed_at",
    },
  },
  qaPrompts: {
    sqlName: "qa_prompts",
    columns: {
      id: "id",
      name: "name",
      prompt: "prompt",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  },
  ticketActivityLog: {
    sqlName: "ticket_activity_log",
    columns: {
      id: "id",
      projectId: "project_id",
      epicId: "epic_id",
      fromStatus: "from_status",
      toStatus: "to_status",
      actor: "actor",
      reason: "reason",
      sessionId: "session_id",
      createdAt: "created_at",
    },
  },
  notifications: {
    sqlName: "notifications",
    columns: {
      id: "id",
      projectId: "project_id",
      projectName: "project_name",
      sessionId: "session_id",
      agentType: "agent_type",
      status: "status",
      title: "title",
      targetUrl: "target_url",
      createdAt: "created_at",
    },
  },
  notificationReadCursor: {
    sqlName: "notification_read_cursor",
    columns: {
      id: "id",
      readAt: "read_at",
    },
  },
  ticketReadCursors: {
    sqlName: "ticket_read_cursors",
    columns: {
      epicId: "epic_id",
      lastReadAt: "last_read_at",
      updatedAt: "updated_at",
    },
  },
  providerUsageSnapshots: {
    sqlName: "provider_usage_snapshots",
    columns: {
      provider: "provider",
      capturedAt: "captured_at",
      planType: "plan_type",
      primaryUsedPercent: "primary_used_percent",
      primaryWindowMinutes: "primary_window_minutes",
      primaryResetsAt: "primary_resets_at",
      secondaryUsedPercent: "secondary_used_percent",
      secondaryWindowMinutes: "secondary_window_minutes",
      secondaryResetsAt: "secondary_resets_at",
      sourceFile: "source_file",
      rawJson: "raw_json",
      updatedAt: "updated_at",
    },
  },
};

/** Every SQLiteTable exported from the schema module, keyed by export name. */
const exportedTables = Object.entries(schema).filter(([, value]) =>
  is(value as never, SQLiteTable)
) as [string, SQLiteTable][];

/** Column bag of a table, keyed by JS property name. */
function columnsOf(table: SQLiteTable): Record<string, { name: string; notNull: boolean; default: unknown }> {
  return table as unknown as Record<string, { name: string; notNull: boolean; default: unknown }>;
}

function tableByExportName(exportName: string): SQLiteTable {
  const entry = exportedTables.find(([name]) => name === exportName);
  if (!entry) throw new Error(`schema does not export a table named "${exportName}"`);
  return entry[1];
}

// ---------------------------------------------------------------------------
// 1. Columns
// ---------------------------------------------------------------------------

describe("db schema: table coverage", () => {
  it("every exported drizzle table has a column spec", () => {
    const exported = exportedTables.map(([name]) => name).sort();
    const specced = Object.keys(TABLE_COLUMNS).sort();
    expect(exported).toEqual(specced);
  });

  it("every column spec names an actually exported table", () => {
    for (const name of Object.keys(TABLE_COLUMNS)) {
      expect(() => tableByExportName(name)).not.toThrow();
    }
  });
});

describe.each(Object.entries(TABLE_COLUMNS))(
  "db schema: %s columns",
  (exportName, spec) => {
    const table = tableByExportName(exportName);

    it(`maps to SQL table "${spec.sqlName}"`, () => {
      expect(getTableName(table)).toBe(spec.sqlName);
    });

    it("exposes exactly the expected columns", () => {
      expect(Object.keys(columnsOf(table)).sort()).toEqual(
        Object.keys(spec.columns).sort()
      );
    });

    it("uses the expected SQL column names", () => {
      const actual = Object.fromEntries(
        Object.entries(columnsOf(table)).map(([key, col]) => [key, col.name])
      );
      expect(actual).toEqual(spec.columns);
    });
  }
);

// ---------------------------------------------------------------------------
// 2. Defaults / nullability
// ---------------------------------------------------------------------------

const DEFAULTS: [string, string, unknown][] = [
  ["projects", "status", "ideation"],
  ["projects", "imported", 0],
  ["projects", "ticketCounter", 0],
  ["documents", "kind", "text"],
  ["epics", "priority", 0],
  ["epics", "status", "backlog"],
  ["epics", "position", 0],
  ["epics", "type", "feature"],
  ["userStories", "status", "todo"],
  ["userStories", "position", 0],
  ["chatConversations", "type", "brainstorm"],
  ["chatConversations", "label", "Brainstorm"],
  ["chatConversations", "status", "active"],
  ["chatConversations", "provider", "claude-code"],
  ["agentSessions", "status", "queued"],
  ["agentSessions", "mode", "code"],
  ["agentSessions", "orchestrationMode", "solo"],
  ["agentSessions", "provider", "claude-code"],
  ["agentSessionSequences", "nextSequence", 1],
  ["pullRequests", "status", "open"],
  ["pullRequests", "baseBranch", "main"],
  ["customReviewAgents", "position", 0],
  ["customReviewAgents", "isEnabled", 1],
  ["ticketDependencies", "scopeType", "project"],
  ["reviewComments", "author", "user"],
  ["reviewComments", "status", "open"],
  ["qaReports", "status", "running"],
  ["qaReports", "checkType", "tech_check"],
];

describe("db schema: column defaults", () => {
  it.each(DEFAULTS)("%s.%s defaults to %o", (exportName, column, expected) => {
    const col = columnsOf(tableByExportName(exportName))[column];
    expect(col).toBeDefined();
    expect(col.default).toBe(expected);
  });
});

const NOT_NULL: [string, string][] = [
  ["projects", "name"],
  ["documents", "projectId"],
  ["documents", "originalFilename"],
  ["epics", "projectId"],
  ["epics", "title"],
  ["userStories", "epicId"],
  ["userStories", "title"],
  ["chatMessages", "role"],
  ["chatMessages", "content"],
  ["chatAttachments", "fileName"],
  ["chatAttachments", "filePath"],
  ["chatAttachments", "mimeType"],
  ["chatAttachments", "sizeBytes"],
  ["agentSessionChunks", "streamType"],
  ["agentSessionChunks", "sequence"],
  ["agentSessionChunks", "content"],
  ["releases", "version"],
  ["pullRequests", "number"],
  ["pullRequests", "url"],
  ["pullRequests", "title"],
  ["pullRequests", "status"],
  ["pullRequests", "headBranch"],
  ["pullRequests", "baseBranch"],
  ["gitSyncLog", "operation"],
  ["gitSyncLog", "status"],
  ["githubIssues", "issueNumber"],
  ["githubIssues", "title"],
  ["githubIssues", "githubUrl"],
  ["reviewComments", "filePath"],
  ["reviewComments", "lineNumber"],
  ["reviewComments", "body"],
  ["ticketActivityLog", "fromStatus"],
  ["ticketActivityLog", "toStatus"],
  ["ticketActivityLog", "actor"],
  ["notifications", "projectName"],
  ["notifications", "status"],
  ["notifications", "title"],
  ["notifications", "targetUrl"],
  ["notificationReadCursor", "readAt"],
  ["ticketReadCursors", "lastReadAt"],
  ["ticketReadCursors", "updatedAt"],
  // A snapshot without its provider event timestamp or its raw payload could
  // not be aged or re-parsed — both are load-bearing for honest staleness.
  ["providerUsageSnapshots", "capturedAt"],
  ["providerUsageSnapshots", "rawJson"],
];

describe("db schema: NOT NULL columns", () => {
  it.each(NOT_NULL)("%s.%s is NOT NULL", (exportName, column) => {
    expect(columnsOf(tableByExportName(exportName))[column].notNull).toBe(true);
  });
});

/** Optional integration fields — writing a row without them must stay legal. */
const NULLABLE: [string, string][] = [
  ["projects", "githubOwnerRepo"],
  ["projects", "gitRepoPath"],
  ["projects", "cloneSource"],
  ["projects", "gitRemoteUrl"],
  ["projects", "defaultBranch"],
  ["epics", "prNumber"],
  ["epics", "prUrl"],
  ["epics", "prStatus"],
  ["epics", "githubIssueNumber"],
  ["epics", "githubIssueUrl"],
  ["epics", "githubIssueState"],
  ["epics", "releaseId"],
  ["releases", "githubReleaseId"],
  ["releases", "githubReleaseUrl"],
  ["releases", "pushedAt"],
  ["gitSyncLog", "branch"],
  ["gitSyncLog", "detail"],
  // A clone is logged before any project row exists — see migration
  // 0029_git_sync_log_nullable_project.
  ["gitSyncLog", "projectId"],
  ["githubIssues", "importedEpicId"],
  ["githubIssues", "importedAt"],
  ["agentSessions", "cliSessionId"],
  ["agentSessions", "namedAgentId"],
  ["agentSessions", "inputTokens"],
  ["agentSessions", "outputTokens"],
  ["agentSessions", "totalCostUsd"],
  ["chatConversations", "cliSessionId"],
  ["chatConversations", "namedAgentId"],
  ["notifications", "sessionId"],
  ["notifications", "agentType"],
];

describe("db schema: nullable columns", () => {
  it.each(NULLABLE)("%s.%s is nullable", (exportName, column) => {
    expect(columnsOf(tableByExportName(exportName))[column].notNull).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 3. Indexes and unique constraints
// ---------------------------------------------------------------------------

type IndexSpec = { name: string; unique: boolean; columns: string[] };

const INDEXES: Record<string, IndexSpec[]> = {
  documents: [
    {
      name: "documents_project_filename_unique",
      unique: true,
      columns: ["project_id", "original_filename"],
    },
    {
      name: "documents_project_created_at_idx",
      unique: false,
      columns: ["project_id", "created_at"],
    },
  ],
  agentSessionChunks: [
    {
      name: "agent_session_chunks_session_sequence_unique",
      unique: true,
      columns: ["session_id", "sequence"],
    },
    {
      name: "agent_session_chunks_session_stream_key_unique",
      unique: true,
      columns: ["session_id", "stream_type", "chunk_key"],
    },
    {
      name: "agent_session_chunks_session_stream_sequence_idx",
      unique: false,
      columns: ["session_id", "stream_type", "sequence"],
    },
  ],
  agentPrompts: [
    {
      name: "agent_prompts_agent_type_scope_unique",
      unique: true,
      columns: ["agent_type", "scope"],
    },
  ],
  customReviewAgents: [
    {
      name: "custom_review_agents_name_scope_unique",
      unique: true,
      columns: ["name", "scope"],
    },
  ],
  namedAgents: [
    { name: "named_agents_name_unique", unique: true, columns: ["name"] },
    {
      name: "named_agents_readable_agent_name_unique",
      unique: true,
      columns: ["readable_agent_name"],
    },
  ],
  agentProviderDefaults: [
    {
      name: "agent_provider_defaults_agent_type_scope_unique",
      unique: true,
      columns: ["agent_type", "scope"],
    },
  ],
  ticketDependencies: [
    {
      name: "ticket_dependencies_edge_unique",
      unique: true,
      columns: ["ticket_id", "depends_on_ticket_id"],
    },
    {
      name: "ticket_dependencies_ticket_idx",
      unique: false,
      columns: ["ticket_id"],
    },
    {
      name: "ticket_dependencies_depends_on_idx",
      unique: false,
      columns: ["depends_on_ticket_id"],
    },
    {
      name: "ticket_dependencies_project_idx",
      unique: false,
      columns: ["project_id"],
    },
  ],
  reviewComments: [
    {
      name: "review_comments_epic_file_idx",
      unique: false,
      columns: ["epic_id", "file_path"],
    },
  ],
  githubIssues: [
    {
      name: "github_issues_project_issue_unique",
      unique: true,
      columns: ["project_id", "issue_number"],
    },
    {
      name: "github_issues_project_synced_idx",
      unique: false,
      columns: ["project_id", "synced_at"],
    },
  ],
  qaPrompts: [
    { name: "qa_prompts_name_unique", unique: true, columns: ["name"] },
  ],
  ticketActivityLog: [
    {
      name: "ticket_activity_log_epic_idx",
      unique: false,
      columns: ["epic_id"],
    },
    {
      name: "ticket_activity_log_project_idx",
      unique: false,
      columns: ["project_id"],
    },
  ],
  notifications: [
    {
      name: "notifications_created_at_idx",
      unique: false,
      columns: ["created_at"],
    },
  ],
};

describe("db schema: indexes and unique constraints", () => {
  it.each(Object.entries(INDEXES))("%s declares its indexes", (exportName, specs) => {
    const actual = getTableConfig(tableByExportName(exportName)).indexes.map(
      (idx) => ({
        name: idx.config.name,
        unique: idx.config.unique,
        columns: (idx.config.columns as { name: string }[]).map((c) => c.name),
      })
    );
    expect(actual).toEqual(specs);
  });

  it("tables without declared indexes have none", () => {
    for (const [exportName, table] of exportedTables) {
      if (exportName in INDEXES) continue;
      expect(getTableConfig(table).indexes).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Foreign keys
// ---------------------------------------------------------------------------

type ForeignKeySpec = {
  columns: string[];
  foreignTable: string;
  foreignColumns: string[];
  onDelete?: string;
};

const FOREIGN_KEYS: Record<string, ForeignKeySpec[]> = {
  documents: [
    { columns: ["project_id"], foreignTable: "projects", foreignColumns: ["id"], onDelete: "cascade" },
  ],
  epics: [
    { columns: ["project_id"], foreignTable: "projects", foreignColumns: ["id"], onDelete: "cascade" },
    { columns: ["linked_epic_id"], foreignTable: "epics", foreignColumns: ["id"], onDelete: "set null" },
    { columns: ["release_id"], foreignTable: "releases", foreignColumns: ["id"], onDelete: "set null" },
  ],
  userStories: [
    { columns: ["epic_id"], foreignTable: "epics", foreignColumns: ["id"], onDelete: "cascade" },
  ],
  pullRequests: [
    { columns: ["project_id"], foreignTable: "projects", foreignColumns: ["id"], onDelete: "cascade" },
    { columns: ["epic_id"], foreignTable: "epics", foreignColumns: ["id"], onDelete: "set null" },
  ],
  releases: [
    { columns: ["project_id"], foreignTable: "projects", foreignColumns: ["id"], onDelete: "cascade" },
  ],
  gitSyncLog: [
    { columns: ["project_id"], foreignTable: "projects", foreignColumns: ["id"], onDelete: "cascade" },
  ],
  githubIssues: [
    { columns: ["project_id"], foreignTable: "projects", foreignColumns: ["id"], onDelete: "cascade" },
    { columns: ["imported_epic_id"], foreignTable: "epics", foreignColumns: ["id"], onDelete: "set null" },
  ],
  reviewComments: [
    { columns: ["epic_id"], foreignTable: "epics", foreignColumns: ["id"], onDelete: "cascade" },
  ],
  notifications: [
    { columns: ["project_id"], foreignTable: "projects", foreignColumns: ["id"], onDelete: "cascade" },
    { columns: ["session_id"], foreignTable: "agent_sessions", foreignColumns: ["id"], onDelete: "set null" },
  ],
  agentSessionChunks: [
    { columns: ["session_id"], foreignTable: "agent_sessions", foreignColumns: ["id"], onDelete: "cascade" },
  ],
};

describe("db schema: foreign keys", () => {
  it.each(Object.entries(FOREIGN_KEYS))("%s references the right tables", (exportName, specs) => {
    const actual = getTableConfig(tableByExportName(exportName)).foreignKeys.map(
      (fk) => {
        const ref = fk.reference();
        return {
          columns: ref.columns.map((c) => c.name),
          foreignTable: getTableName(ref.foreignTable),
          foreignColumns: ref.foreignColumns.map((c) => c.name),
          onDelete: fk.onDelete,
        };
      }
    );
    expect(actual).toEqual(specs);
  });
});

// ---------------------------------------------------------------------------
// 5. Exported types (compile-time shape checks)
// ---------------------------------------------------------------------------

describe("db schema: exported types", () => {
  it("GitSyncLog select shape", () => {
    const log: schema.GitSyncLog = {
      id: "sl_1",
      projectId: "proj_1",
      operation: "push",
      branch: "main",
      status: "success",
      detail: null,
      createdAt: null,
    };
    expect(log.operation).toBe("push");
    expect(log.status).toBe("success");
  });

  it("Release select shape, with and without GitHub fields", () => {
    const published: schema.Release = {
      id: "rel_1",
      projectId: "proj_1",
      version: "1.0.0",
      title: "First Release",
      changelog: "# Changes",
      epicIds: '["ep_1"]',
      releaseBranch: "release/v1.0.0",
      gitTag: "v1.0.0",
      githubReleaseId: 12345,
      githubReleaseUrl: "https://github.com/owner/repo/releases/12345",
      pushedAt: "2025-01-01T00:00:00Z",
      createdAt: "2025-01-01T00:00:00Z",
    };
    const localOnly: schema.Release = {
      id: "rel_2",
      projectId: "proj_1",
      version: "0.1.0",
      title: null,
      changelog: null,
      epicIds: null,
      releaseBranch: null,
      gitTag: null,
      githubReleaseId: null,
      githubReleaseUrl: null,
      pushedAt: null,
      createdAt: null,
    };
    expect(published.githubReleaseId).toBe(12345);
    expect(published.githubReleaseUrl).toContain("github.com");
    expect(localOnly.githubReleaseId).toBeNull();
    expect(localOnly.pushedAt).toBeNull();
  });

  it("PullRequest select shape", () => {
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

  it("agent-config select shapes", () => {
    const agentPrompt: schema.AgentPrompt = {
      id: "ap_1",
      agentType: "build",
      systemPrompt: "Prompt",
      scope: "global",
      createdAt: null,
      updatedAt: null,
    };
    const customReviewAgent: schema.CustomReviewAgent = {
      id: "cra_1",
      name: "UI Review",
      systemPrompt: "Review UI details",
      scope: "global",
      position: 0,
      isEnabled: 1,
      createdAt: null,
      updatedAt: null,
    };
    const providerDefault: schema.AgentProviderDefault = {
      id: "apd_1",
      agentType: "build",
      provider: "claude-code",
      namedAgentId: null,
      scope: "global",
      createdAt: null,
      updatedAt: null,
    };
    expect(agentPrompt.agentType).toBe("build");
    expect(customReviewAgent.name).toBe("UI Review");
    expect(providerDefault.provider).toBe("claude-code");
  });

  it("QA select shapes", () => {
    const report: schema.QaReport = {
      id: "qr_1",
      projectId: "proj_1",
      status: "running",
      agentSessionId: null,
      namedAgentId: null,
      promptUsed: null,
      customPromptId: null,
      reportContent: null,
      summary: null,
      checkType: "tech_check",
      createdAt: null,
      completedAt: null,
    };
    const prompt: schema.QaPrompt = {
      id: "qp_1",
      name: "Backend Audit",
      prompt: "Check security and performance.",
      createdAt: null,
      updatedAt: null,
    };
    expect(report.status).toBe("running");
    expect(prompt.name).toBe("Backend Audit");
  });

  it("Notification select shapes", () => {
    const notification: schema.Notification = {
      id: "n1",
      projectId: "p1",
      projectName: "My Project",
      sessionId: "s1",
      agentType: "build",
      status: "completed",
      title: "Build completed",
      targetUrl: "/projects/p1/sessions/s1",
      createdAt: null,
    };
    const cursor: schema.NotificationReadCursor = {
      id: 1,
      readAt: "2026-01-01T00:00:00.000Z",
    };
    expect(notification.status).toBe("completed");
    expect(cursor.id).toBe(1);
  });

  it("TicketReadCursor select shape", () => {
    const cursor: schema.TicketReadCursor = {
      epicId: "e1",
      lastReadAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(cursor.epicId).toBe("e1");
  });

  it("ReviewComment aliases exist", () => {
    const selected: schema.ReviewComment | undefined = undefined;
    const inserted: schema.NewReviewComment | undefined = undefined;
    expect(selected).toBeUndefined();
    expect(inserted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Behaviour against a real migrated database
// ---------------------------------------------------------------------------

/**
 * Indexes whose real SQL name differs from the drizzle declaration. Drizzle
 * cannot express expression indexes, so `documents` declares a plain composite
 * unique index while migration 0014 creates a case-insensitive one over
 * `LOWER(original_filename)` under a different name.
 */
const MIGRATION_INDEX_NAMES: Record<string, string> = {
  documents_project_filename_unique: "documents_project_filename_ci_unique",
};

describe("db schema: migrated database", () => {
  it("creates a table for every schema export", () => {
    const { sqlite } = createTestDb();
    try {
      const tableNames = (
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((t) => t.name);

      for (const spec of Object.values(TABLE_COLUMNS)) {
        expect(tableNames).toContain(spec.sqlName);
      }
    } finally {
      sqlite.close();
    }
  });

  it("creates the declared indexes", () => {
    const { sqlite } = createTestDb();
    try {
      const indexNames = (
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='index'")
          .all() as { name: string }[]
      ).map((i) => i.name);

      const expectedNames = Object.values(INDEXES)
        .flat()
        .map((spec) => MIGRATION_INDEX_NAMES[spec.name] ?? spec.name);
      const missing = expectedNames.filter((name) => !indexNames.includes(name));
      expect(missing).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("enforces the notifications project_id foreign key", () => {
    const { sqlite } = createTestDb();
    try {
      expect(() => {
        sqlite
          .prepare(
            "INSERT INTO notifications (id, project_id, project_name, status, title, target_url) VALUES ('n1', 'nonexistent', 'Test', 'completed', 'Title', '/url')"
          )
          .run();
      }).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("round-trips a notification row", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'MyProject')").run();
      sqlite
        .prepare(
          "INSERT INTO notifications (id, project_id, project_name, session_id, agent_type, status, title, target_url) VALUES ('n1', 'p1', 'MyProject', NULL, 'build', 'completed', 'Build done', '/projects/p1')"
        )
        .run();

      const rows = sqlite
        .prepare("SELECT * FROM notifications")
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].project_name).toBe("MyProject");
      expect(rows[0].status).toBe("completed");
    } finally {
      sqlite.close();
    }
  });

  it("supports the single-row notification_read_cursor upsert", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite
        .prepare(
          "INSERT INTO notification_read_cursor (id, read_at) VALUES (1, '2026-01-01T00:00:00.000Z')"
        )
        .run();
      sqlite
        .prepare(
          "INSERT OR REPLACE INTO notification_read_cursor (id, read_at) VALUES (1, '2026-02-01T00:00:00.000Z')"
        )
        .run();

      const rows = sqlite
        .prepare("SELECT * FROM notification_read_cursor")
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);
      expect(rows[0].read_at).toBe("2026-02-01T00:00:00.000Z");
    } finally {
      sqlite.close();
    }
  });

  it("round-trips agent session usage columns", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'MyProject')").run();
      sqlite
        .prepare(
          "INSERT INTO agent_sessions (id, project_id, input_tokens, output_tokens, total_cost_usd) VALUES ('s1', 'p1', 1500, 320, 0.0421)"
        )
        .run();
      sqlite
        .prepare("INSERT INTO agent_sessions (id, project_id) VALUES ('s2', 'p1')")
        .run();

      const rows = sqlite
        .prepare("SELECT * FROM agent_sessions ORDER BY id")
        .all() as Record<string, unknown>[];
      expect(rows[0].input_tokens).toBe(1500);
      expect(rows[0].output_tokens).toBe(320);
      expect(rows[0].total_cost_usd).toBeCloseTo(0.0421);
      // Usage is optional: legacy/non-reporting sessions stay NULL.
      expect(rows[1].input_tokens).toBeNull();
      expect(rows[1].output_tokens).toBeNull();
      expect(rows[1].total_cost_usd).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("supports the per-epic ticket_read_cursors upsert", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite
        .prepare(
          "INSERT INTO ticket_read_cursors (epic_id, last_read_at, updated_at) VALUES ('e1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO ticket_read_cursors (epic_id, last_read_at, updated_at) VALUES ('e2', '2026-01-15T00:00:00.000Z', '2026-01-15T00:00:00.000Z')"
        )
        .run();
      // One cursor per epic: re-inserting the same epic replaces its row.
      sqlite
        .prepare(
          "INSERT OR REPLACE INTO ticket_read_cursors (epic_id, last_read_at, updated_at) VALUES ('e1', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')"
        )
        .run();

      const rows = sqlite
        .prepare("SELECT * FROM ticket_read_cursors ORDER BY epic_id")
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[0].epic_id).toBe("e1");
      expect(rows[0].last_read_at).toBe("2026-02-01T00:00:00.000Z");
      expect(rows[1].epic_id).toBe("e2");
    } finally {
      sqlite.close();
    }
  });

  it("cascades notification deletes when the project is removed", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'MyProject')").run();
      sqlite
        .prepare(
          "INSERT INTO notifications (id, project_id, project_name, status, title, target_url) VALUES ('n1', 'p1', 'MyProject', 'completed', 'Title', '/url')"
        )
        .run();

      sqlite.prepare("DELETE FROM projects WHERE id = 'p1'").run();

      expect(sqlite.prepare("SELECT * FROM notifications").all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  it("accepts a project-less git_sync_log row (clone runs before the project exists)", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite
        .prepare(
          "INSERT INTO git_sync_log (id, project_id, operation, status, detail) VALUES ('g1', NULL, 'clone', 'success', '{\"reused\":false}')"
        )
        .run();

      const rows = sqlite
        .prepare("SELECT * FROM git_sync_log")
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].project_id).toBeNull();
      expect(rows[0].operation).toBe("clone");
    } finally {
      sqlite.close();
    }
  });

  it("keeps the git_sync_log foreign key after the nullable rebuild", () => {
    const { sqlite } = createTestDb();
    try {
      sqlite.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'MyProject')").run();
      sqlite
        .prepare(
          "INSERT INTO git_sync_log (id, project_id, operation, status) VALUES ('g1', 'p1', 'push', 'success')"
        )
        .run();

      // A bogus project is still rejected...
      expect(() =>
        sqlite
          .prepare(
            "INSERT INTO git_sync_log (id, project_id, operation, status) VALUES ('g2', 'nope', 'push', 'success')"
          )
          .run()
      ).toThrow(/FOREIGN KEY/i);

      // ...and rows that do belong to a project still cascade.
      sqlite.prepare("DELETE FROM projects WHERE id = 'p1'").run();
      expect(sqlite.prepare("SELECT * FROM git_sync_log").all()).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});
