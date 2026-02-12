import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
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
