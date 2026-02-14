import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").default("ideation"), // ideation | specifying | building | done | archived
  gitRepoPath: text("git_repo_path"),
  githubOwnerRepo: text("github_owner_repo"),
  spec: text("spec"),
  imported: integer("imported").default(0),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  originalFilename: text("original_filename").notNull(),
  kind: text("kind").notNull().default("text"), // text | image
  markdownContent: text("markdown_content"),
  imagePath: text("image_path"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
},
(table) => ({
  // Case-insensitive uniqueness is enforced in SQL migration via lower(original_filename).
  projectFilenameUnique: uniqueIndex("documents_project_filename_unique").on(
    table.projectId,
    table.originalFilename
  ),
  projectCreatedAtIdx: index("documents_project_created_at_idx").on(
    table.projectId,
    table.createdAt
  ),
}));

export const epics = sqliteTable("epics", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  priority: integer("priority").default(0), // 0=low, 1=medium, 2=high, 3=critical
  status: text("status").default("backlog"), // backlog | todo | in_progress | review | done
  position: integer("position").default(0),
  branchName: text("branch_name"),
  prNumber: integer("pr_number"),
  prUrl: text("pr_url"),
  prStatus: text("pr_status"), // draft | open | closed | merged
  confidence: real("confidence"),
  evidence: text("evidence"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
  type: text("type").default("feature"), // 'feature' | 'bug'
  linkedEpicId: text("linked_epic_id").references((): AnySQLiteColumn => epics.id, { onDelete: "set null" }),
  images: text("images"), // JSON array of image paths
});

export const userStories = sqliteTable("user_stories", {
  id: text("id").primaryKey(),
  epicId: text("epic_id")
    .notNull()
    .references(() => epics.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  acceptanceCriteria: text("acceptance_criteria"),
  status: text("status").default("todo"), // todo | in_progress | review | done
  position: integer("position").default(0),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const chatConversations = sqliteTable("chat_conversations", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  type: text("type").notNull().default("brainstorm"), // brainstorm | epic
  label: text("label").notNull().default("Brainstorm"),
  status: text("status").default("active"), // active | generating | generated | error
  epicId: text("epic_id").references(() => epics.id),
  provider: text("provider").default("claude-code"), // claude-code | codex | gemini-cli
  claudeSessionId: text("claude_session_id"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").references(() => chatConversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | assistant
  content: text("content").notNull(),
  metadata: text("metadata"), // JSON
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const chatAttachments = sqliteTable("chat_attachments", {
  id: text("id").primaryKey(),
  chatMessageId: text("chat_message_id").references(() => chatMessages.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  epicId: text("epic_id").references(() => epics.id),
  userStoryId: text("user_story_id").references(() => userStories.id),
  status: text("status").default("queued"), // queued | running | completed | failed | cancelled
  mode: text("mode").default("code"), // plan | code
  orchestrationMode: text("orchestration_mode").default("solo"), // solo | team
  provider: text("provider").default("claude-code"), // claude-code | codex | gemini-cli
  prompt: text("prompt"),
  logsPath: text("logs_path"),
  branchName: text("branch_name"),
  worktreePath: text("worktree_path"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  completedAt: text("completed_at"),
  lastNonEmptyText: text("last_non_empty_text"),
  error: text("error"),
  claudeSessionId: text("claude_session_id"),
  agentType: text("agent_type"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const agentSessionSequences = sqliteTable("agent_session_sequences", {
  sessionId: text("session_id")
    .primaryKey()
    .notNull()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  nextSequence: integer("next_sequence").notNull().default(1),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const agentSessionChunks = sqliteTable(
  "agent_session_chunks",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    streamType: text("stream_type").notNull(), // raw | output | response
    sequence: integer("sequence").notNull(),
    chunkKey: text("chunk_key"),
    content: text("content").notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    sessionSequenceUnique: uniqueIndex(
      "agent_session_chunks_session_sequence_unique"
    ).on(table.sessionId, table.sequence),
    sessionStreamKeyUnique: uniqueIndex(
      "agent_session_chunks_session_stream_key_unique"
    ).on(table.sessionId, table.streamType, table.chunkKey),
    sessionStreamSequenceIdx: index(
      "agent_session_chunks_session_stream_sequence_idx"
    ).on(table.sessionId, table.streamType, table.sequence),
  })
);

export const ticketComments = sqliteTable("ticket_comments", {
  id: text("id").primaryKey(),
  userStoryId: text("user_story_id").references(() => userStories.id, {
    onDelete: "cascade",
  }),
  epicId: text("epic_id").references(() => epics.id, { onDelete: "cascade" }),
  author: text("author").notNull(), // user | agent
  content: text("content").notNull(),
  agentSessionId: text("agent_session_id").references(() => agentSessions.id),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const releases = sqliteTable("releases", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  title: text("title"),
  changelog: text("changelog"), // markdown
  epicIds: text("epic_ids"), // JSON array of epic IDs
  gitTag: text("git_tag"),
  githubReleaseId: integer("github_release_id"),
  githubReleaseUrl: text("github_release_url"),
  pushedAt: text("pushed_at"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const pullRequests = sqliteTable("pull_requests", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  epicId: text("epic_id").references(() => epics.id, { onDelete: "set null" }),
  number: integer("number").notNull(),
  url: text("url").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("open"), // draft | open | closed | merged
  headBranch: text("head_branch").notNull(),
  baseBranch: text("base_branch").notNull().default("main"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export const agentPrompts = sqliteTable(
  "agent_prompts",
  {
    id: text("id").primaryKey(),
    agentType: text("agent_type").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    scope: text("scope").notNull(), // 'global' | projectId
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    agentTypeScopeUnique: uniqueIndex("agent_prompts_agent_type_scope_unique").on(
      table.agentType,
      table.scope
    ),
  }),
);

export const customReviewAgents = sqliteTable(
  "custom_review_agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    systemPrompt: text("system_prompt").notNull(),
    scope: text("scope").notNull(), // 'global' | projectId
    position: integer("position").notNull().default(0),
    isEnabled: integer("is_enabled").notNull().default(1),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameScopeUnique: uniqueIndex("custom_review_agents_name_scope_unique").on(
      table.name,
      table.scope
    ),
  }),
);

export const namedAgents = sqliteTable(
  "named_agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    provider: text("provider").notNull(), // 'claude-code' | 'codex' | 'gemini-cli'
    model: text("model").notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameUnique: uniqueIndex("named_agents_name_unique").on(table.name),
  }),
);

export const agentProviderDefaults = sqliteTable(
  "agent_provider_defaults",
  {
    id: text("id").primaryKey(),
    agentType: text("agent_type").notNull(),
    provider: text("provider").notNull(), // 'claude-code' | 'codex' | 'gemini-cli'
    namedAgentId: text("named_agent_id").references(() => namedAgents.id, { onDelete: "set null" }),
    scope: text("scope").notNull(), // 'global' | projectId
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    agentTypeScopeUnique: uniqueIndex("agent_provider_defaults_agent_type_scope_unique").on(
      table.agentType,
      table.scope
    ),
  }),
);

export const ticketDependencies = sqliteTable(
  "ticket_dependencies",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id")
      .notNull()
      .references(() => epics.id, { onDelete: "cascade" }),
    dependsOnTicketId: text("depends_on_ticket_id")
      .notNull()
      .references(() => epics.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull().default("project"), // project | (future: cross-project)
    scopeId: text("scope_id").notNull(), // projectId for now; future: org/workspace id
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    dependencyUnique: uniqueIndex("ticket_dependencies_edge_unique").on(
      table.ticketId,
      table.dependsOnTicketId
    ),
    ticketIdx: index("ticket_dependencies_ticket_idx").on(table.ticketId),
    dependsOnIdx: index("ticket_dependencies_depends_on_idx").on(
      table.dependsOnTicketId
    ),
    projectIdx: index("ticket_dependencies_project_idx").on(table.projectId),
  })
);

export const gitSyncLog = sqliteTable("git_sync_log", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  operation: text("operation").notNull(), // push | pull | fetch | detect | tag_push | pr_create | pr_sync | release
  branch: text("branch"),
  status: text("status").notNull(), // success | failure
  detail: text("detail"), // JSON payload for error info
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export type GitSyncLog = typeof gitSyncLog.$inferSelect;
export type NewGitSyncLog = typeof gitSyncLog.$inferInsert;

export type AgentPrompt = typeof agentPrompts.$inferSelect;
export type NewAgentPrompt = typeof agentPrompts.$inferInsert;

export type CustomReviewAgent = typeof customReviewAgents.$inferSelect;
export type NewCustomReviewAgent = typeof customReviewAgents.$inferInsert;

export type AgentProviderDefault = typeof agentProviderDefaults.$inferSelect;
export type NewAgentProviderDefault = typeof agentProviderDefaults.$inferInsert;

export type NamedAgent = typeof namedAgents.$inferSelect;
export type NewNamedAgent = typeof namedAgents.$inferInsert;

export type PullRequest = typeof pullRequests.$inferSelect;
export type NewPullRequest = typeof pullRequests.$inferInsert;

export type Release = typeof releases.$inferSelect;
export type NewRelease = typeof releases.$inferInsert;

export type TicketDependency = typeof ticketDependencies.$inferSelect;
export type NewTicketDependency = typeof ticketDependencies.$inferInsert;
