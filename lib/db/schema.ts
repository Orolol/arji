import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").default("ideation"), // ideation | specifying | building | done | archived
  gitRepoPath: text("git_repo_path"),
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
  name: text("name").notNull(),
  contentMd: text("content_md").notNull(),
  mimeType: text("mime_type"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

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
  confidence: real("confidence"),
  evidence: text("evidence"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
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
  provider: text("provider").default("claude-code"), // claude-code | codex
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
  status: text("status").default("pending"), // pending | running | completed | failed | cancelled
  mode: text("mode").default("code"), // plan | code
  orchestrationMode: text("orchestration_mode").default("solo"), // solo | team
  provider: text("provider").default("claude-code"), // claude-code | codex
  prompt: text("prompt"),
  logsPath: text("logs_path"),
  branchName: text("branch_name"),
  worktreePath: text("worktree_path"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  error: text("error"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

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
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
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

export const agentProviderDefaults = sqliteTable(
  "agent_provider_defaults",
  {
    id: text("id").primaryKey(),
    agentType: text("agent_type").notNull(),
    provider: text("provider").notNull(), // 'claude-code' | 'codex'
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

export type AgentPrompt = typeof agentPrompts.$inferSelect;
export type NewAgentPrompt = typeof agentPrompts.$inferInsert;

export type CustomReviewAgent = typeof customReviewAgents.$inferSelect;
export type NewCustomReviewAgent = typeof customReviewAgents.$inferInsert;

export type AgentProviderDefault = typeof agentProviderDefaults.$inferSelect;
export type NewAgentProviderDefault = typeof agentProviderDefaults.$inferInsert;
