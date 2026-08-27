import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  check,
  AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  FrictionCategory,
  FrictionStatus,
} from "@/lib/frictions/constants";
import type { RoutineKind } from "@/lib/routines/constants";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").default("ideation"), // ideation | specifying | building | done | archived
  gitRepoPath: text("git_repo_path"),
  githubOwnerRepo: text("github_owner_repo"),
  // "github" when Arij cloned the directory itself and therefore owns it;
  // NULL for user-supplied paths, which Arij must never delete.
  cloneSource: text("clone_source"),
  gitRemoteUrl: text("git_remote_url"),
  defaultBranch: text("default_branch"),
  spec: text("spec"),
  imported: integer("imported").default(0),
  ticketCounter: integer("ticket_counter").default(0), // shared sequence across epics+bugs
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export type { RoutineKind } from "@/lib/routines/constants";

/**
 * Durable routine definitions. Daily scheduling is interpreted in the
 * server's local timezone; `lastRunAt` is written before dispatch so a
 * process restart cannot replay a routine already claimed that day.
 */
export const routines = sqliteTable(
  "routines",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<RoutineKind>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    timeOfDay: text("time_of_day").notNull(),
    config: text("config").notNull().default("{}"),
    lastRunAt: text("last_run_at"),
    lastStatus: text("last_status"),
  },
  (table) => ({
    projectKindUnique: uniqueIndex("routines_project_kind_unique").on(
      table.projectId,
      table.kind
    ),
    projectIdx: index("routines_project_idx").on(table.projectId),
    enabledIdx: index("routines_enabled_idx").on(table.enabled),
  })
);

export type Routine = typeof routines.$inferSelect;
export type NewRoutine = typeof routines.$inferInsert;

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
  status: text("status").default("backlog"), // backlog | todo | in_progress | review | done | released
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
  readableId: text("readable_id"), // E-project-001 or B-project-002
  githubIssueNumber: integer("github_issue_number"),
  githubIssueUrl: text("github_issue_url"),
  githubIssueState: text("github_issue_state"),
  releaseId: text("release_id").references(() => releases.id, { onDelete: "set null" }),
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
  provider: text("provider").default("claude-code"), // see PROVIDER_OPTIONS in lib/agent-config/constants.ts
  // Legacy column, scheduled for removal — read only via resolveCliSessionId().
  claudeSessionId: text("claude_session_id"),
  cliSessionId: text("cli_session_id"),
  namedAgentId: text("named_agent_id"),
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

/**
 * An uploaded file and, in the three owner columns, what keeps it alive.
 *
 * `chatMessageId` is set when the staged upload is sent as part of a chat
 * message; `epicId` when it is filed as a bug's screenshot. Both NULL means
 * the upload is still staged in a form nobody has submitted — the only state
 * in which discarding it is allowed. `projectId` is set at upload time and
 * outlives either claim, so deleting a project takes its files with it.
 */
export const chatAttachments = sqliteTable("chat_attachments", {
  id: text("id").primaryKey(),
  chatMessageId: text("chat_message_id").references(() => chatMessages.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  epicId: text("epic_id").references(() => epics.id, { onDelete: "cascade" }),
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
  mode: text("mode").default("code"), // plan | code | analyze | chat
  orchestrationMode: text("orchestration_mode").default("solo"), // solo | team
  provider: text("provider").default("claude-code"), // see PROVIDER_OPTIONS in lib/agent-config/constants.ts
  prompt: text("prompt"),
  logsPath: text("logs_path"),
  branchName: text("branch_name"),
  worktreePath: text("worktree_path"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  completedAt: text("completed_at"),
  lastNonEmptyText: text("last_non_empty_text"),
  error: text("error"),
  // Delivery verdict, set once at session end:
  // answered | asked_question | silent | error. NULL while running/queued,
  // for user-cancelled sessions, and for legacy rows.
  outcome: text("outcome"),
  // Structured review verdict submitted through the MCP `submit_findings`
  // tool: approved | approved_with_minor_issues | changes_requested. The
  // authoritative transition signal for a review stage — see
  // lib/pipeline/findings.ts. NULL for non-review sessions, for reviewers
  // that never called the tool (providers without MCP), and for legacy rows;
  // NULL is what selects the prose-verdict fallback.
  reviewVerdict: text("review_verdict"),
  // Usage reported by the CLI at session end. NULL for legacy rows,
  // non-terminal sessions, and providers that do not report usage.
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalCostUsd: real("total_cost_usd"),
  // Batch/night run that dispatched this session (see lib/night); NULL for
  // standalone dispatches.
  batchRunId: text("batch_run_id"),
  // Legacy column, scheduled for removal — read only via resolveCliSessionId().
  claudeSessionId: text("claude_session_id"),
  cliSessionId: text("cli_session_id"),
  namedAgentId: text("named_agent_id"),
  agentType: text("agent_type"),
  namedAgentName: text("named_agent_name"),
  model: text("model"),
  // Per-CLI options in effect for this run, resolved from the named agent at
  // spawn time. JSON object; NULL for legacy rows and for sessions dispatched
  // without a named agent.
  cliOptions: text("cli_options"),
  cliCommand: text("cli_command"),
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

/**
 * Structured DevX friction reported by an agent session.
 *
 * `agentSessionId` intentionally remains an attributed string rather than a
 * foreign key: friction is durable project memory and must survive later
 * session cleanup. The optional epic link is cleared if its ticket is
 * deleted, while deleting the project removes the project-owned report.
 */
export const frictions = sqliteTable(
  "frictions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    epicId: text("epic_id").references(() => epics.id, {
      onDelete: "set null",
    }),
    agentSessionId: text("agent_session_id").notNull(),
    category: text("category").$type<FrictionCategory>().notNull(),
    description: text("description").notNull(),
    filePath: text("file_path"),
    occurrences: integer("occurrences").notNull().default(1),
    status: text("status").$type<FrictionStatus>().notNull().default("new"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectStatusOccurrencesIdx: index(
      "frictions_project_status_occurrences_idx"
    ).on(table.projectId, table.status, table.occurrences),
    openDedupeIdx: index("frictions_open_dedupe_idx").on(
      table.projectId,
      table.category,
      table.filePath,
      table.status
    ),
    sessionIdx: index("frictions_session_idx").on(table.agentSessionId),
    categoryCheck: check(
      "frictions_category_check",
      sql`${table.category} IN ('broken_tooling', 'misleading_docs', 'flaky_test', 'unclear_convention', 'other')`
    ),
    statusCheck: check(
      "frictions_status_check",
      sql`${table.status} IN ('new', 'triaged', 'converted', 'dismissed')`
    ),
    occurrencesCheck: check(
      "frictions_occurrences_check",
      sql`${table.occurrences} >= 1`
    ),
  })
);

/**
 * A durable visual proof copied out of a session worktree while it still
 * exists. `filename` is the generated basename below
 * data/sessions/<session-id>/artifacts/; source paths are never persisted.
 */
export const sessionArtifacts = sqliteTable(
  "session_artifacts",
  {
    id: text("id").primaryKey(),
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    epicId: text("epic_id")
      .notNull()
      .references(() => epics.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    caption: text("caption").notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    sessionCreatedAtIdx: index("session_artifacts_session_created_at_idx").on(
      table.agentSessionId,
      table.createdAt
    ),
    epicCreatedAtIdx: index("session_artifacts_epic_created_at_idx").on(
      table.epicId,
      table.createdAt
    ),
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
  releaseBranch: text("release_branch"),
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
    provider: text("provider").notNull(), // see PROVIDER_OPTIONS in lib/agent-config/constants.ts
    model: text("model").notNull(),
    readableAgentName: text("readable_agent_name"), // Ancient Greek name
    // Per-CLI options, JSON object of NON-DEFAULT values only. Keys and
    // accepted values are declared in lib/providers/options-registry.ts;
    // '{}' means "every option at the CLI's own default".
    options: text("options").notNull().default("{}"),
    // Free-text persona injected as the first section of the agent's prompt.
    // NULL/blank injects nothing; new agents are created with the product
    // default (see createNamedAgent).
    personaPrompt: text("persona_prompt"),
    escalatesTo: text("escalates_to").references(
      (): AnySQLiteColumn => namedAgents.id,
      { onDelete: "set null" }
    ),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameUnique: uniqueIndex("named_agents_name_unique").on(table.name),
    readableAgentNameUnique: uniqueIndex("named_agents_readable_agent_name_unique").on(table.readableAgentName),
  }),
);

export const agentProviderDefaults = sqliteTable(
  "agent_provider_defaults",
  {
    id: text("id").primaryKey(),
    agentType: text("agent_type").notNull(),
    provider: text("provider").notNull(), // see PROVIDER_OPTIONS in lib/agent-config/constants.ts
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

export const reviewComments = sqliteTable(
  "review_comments",
  {
    id: text("id").primaryKey(),
    epicId: text("epic_id")
      .notNull()
      .references(() => epics.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    lineNumber: integer("line_number").notNull(),
    body: text("body").notNull(),
    author: text("author").notNull().default("user"), // user | agent
    status: text("status").notNull().default("open"), // open | resolved
    // Review session that filed this finding (MCP submit_findings). NULL for
    // user-authored rows and for anything written before migration 0032 —
    // deliberately not backfilled, see that migration. No FK: a finding
    // outlives the session that filed it.
    agentSessionId: text("agent_session_id"),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    epicFileIdx: index("review_comments_epic_file_idx").on(
      table.epicId,
      table.filePath
    ),
  })
);

/**
 * One atomic acceptance-criteria grading submitted by a grader session.
 *
 * `gradings` is the validated JSON array accepted by submit_grading. Keeping
 * the array together preserves the report boundary: downstream pipeline and
 * UI consumers can select the latest report without reconstructing one from
 * independently timestamped criterion rows.
 */
export const gradingReports = sqliteTable(
  "grading_reports",
  {
    id: text("id").primaryKey(),
    epicId: text("epic_id")
      .notNull()
      .references(() => epics.id, { onDelete: "cascade" }),
    agentSessionId: text("agent_session_id").references(
      () => agentSessions.id,
      { onDelete: "set null" }
    ),
    gradings: text("gradings").notNull(), // JSON: GradingEntry[]
    summary: text("summary").notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    epicCreatedAtIdx: index("grading_reports_epic_created_at_idx").on(
      table.epicId,
      table.createdAt
    ),
    sessionIdx: index("grading_reports_session_idx").on(table.agentSessionId),
  })
);

export const gitSyncLog = sqliteTable("git_sync_log", {
  id: text("id").primaryKey(),
  // Nullable since 0029_git_sync_log_nullable_project: a clone is logged
  // before the project row exists (POST /api/projects/clone runs ahead of
  // POST /api/projects), and NOT NULL + FK made those rows un-insertable.
  projectId: text("project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  operation: text("operation").notNull(), // clone | push | pull | fetch | detect | tag_push | pr_create | pr_sync | release
  branch: text("branch"),
  status: text("status").notNull(), // success | failure
  detail: text("detail"), // JSON payload for error info
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const githubIssues = sqliteTable(
  "github_issues",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    issueNumber: integer("issue_number").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    labels: text("labels"), // JSON array
    milestone: text("milestone"),
    assignees: text("assignees"), // JSON array
    githubUrl: text("github_url").notNull(),
    createdAtGitHub: text("created_at_github"),
    updatedAtGitHub: text("updated_at_github"),
    syncedAt: text("synced_at").default(sql`CURRENT_TIMESTAMP`),
    importedEpicId: text("imported_epic_id").references(() => epics.id, { onDelete: "set null" }),
    importedAt: text("imported_at"),
  },
  (table) => ({
    projectIssueUnique: uniqueIndex("github_issues_project_issue_unique").on(
      table.projectId,
      table.issueNumber
    ),
    projectSyncedIdx: index("github_issues_project_synced_idx").on(
      table.projectId,
      table.syncedAt
    ),
  })
);

export const qaReports = sqliteTable("qa_reports", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("running"), // running | completed | failed | cancelled
  agentSessionId: text("agent_session_id").references(() => agentSessions.id, { onDelete: "set null" }),
  namedAgentId: text("named_agent_id").references(() => namedAgents.id, { onDelete: "set null" }),
  promptUsed: text("prompt_used"),
  customPromptId: text("custom_prompt_id"),
  reportContent: text("report_content"),
  summary: text("summary"),
  checkType: text("check_type").notNull().default("tech_check"), // tech_check | e2e_test | failure_digest
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});

/** Deterministic, non-agent test/lint/build results for an epic worktree. */
export const verifyReports = sqliteTable(
  "verify_reports",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    epicId: text("epic_id")
      .notNull()
      .references(() => epics.id, { onDelete: "cascade" }),
    agentSessionId: text("agent_session_id").references(
      () => agentSessions.id,
      { onDelete: "set null" }
    ),
    status: text("status").notNull(), // pass | fail
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at").notNull(),
    commands: text("commands").notNull(), // JSON VerifyCommandResult[]
  },
  (table) => ({
    epicFinishedIdx: index("verify_reports_epic_finished_idx").on(
      table.epicId,
      table.finishedAt
    ),
  })
);

export const qaPrompts = sqliteTable(
  "qa_prompts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameUnique: uniqueIndex("qa_prompts_name_unique").on(table.name),
  }),
);

export type GitSyncLog = typeof gitSyncLog.$inferSelect;
export type NewGitSyncLog = typeof gitSyncLog.$inferInsert;
export type GitHubIssue = typeof githubIssues.$inferSelect;
export type NewGitHubIssue = typeof githubIssues.$inferInsert;

export type QaReport = typeof qaReports.$inferSelect;
export type NewQaReport = typeof qaReports.$inferInsert;

export type VerifyReport = typeof verifyReports.$inferSelect;
export type NewVerifyReport = typeof verifyReports.$inferInsert;

export type QaPrompt = typeof qaPrompts.$inferSelect;
export type NewQaPrompt = typeof qaPrompts.$inferInsert;

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

export type ReviewComment = typeof reviewComments.$inferSelect;
export type NewReviewComment = typeof reviewComments.$inferInsert;

export type GradingReport = typeof gradingReports.$inferSelect;
export type NewGradingReport = typeof gradingReports.$inferInsert;

export type Friction = typeof frictions.$inferSelect;
export type NewFriction = typeof frictions.$inferInsert;

export type SessionArtifact = typeof sessionArtifacts.$inferSelect;
export type NewSessionArtifact = typeof sessionArtifacts.$inferInsert;

export const ticketActivityLog = sqliteTable(
  "ticket_activity_log",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    epicId: text("epic_id")
      .notNull()
      .references(() => epics.id, { onDelete: "cascade" }),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    actor: text("actor").notNull(), // user | agent | system
    reason: text("reason"),
    sessionId: text("session_id"),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    epicIdx: index("ticket_activity_log_epic_idx").on(table.epicId),
    projectIdx: index("ticket_activity_log_project_idx").on(table.projectId),
  })
);

export type TicketActivityLog = typeof ticketActivityLog.$inferSelect;
export type NewTicketActivityLog = typeof ticketActivityLog.$inferInsert;

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    projectName: text("project_name").notNull(), // denormalized for fast reads
    sessionId: text("session_id").references(() => agentSessions.id, {
      onDelete: "set null",
    }),
    agentType: text("agent_type"),
    status: text("status").notNull(), // completed | failed
    title: text("title").notNull(),
    // Full error message for failed session notifications (0031). NULL for
    // completed sessions and non-session notifications — the title alone is
    // not enough for a failure: it is the one place a cross-project user
    // sees "what went wrong" without opening the session.
    message: text("message"),
    targetUrl: text("target_url").notNull(),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    createdAtIdx: index("notifications_created_at_idx").on(table.createdAt),
  })
);

export const notificationReadCursor = sqliteTable("notification_read_cursor", {
  id: integer("id").primaryKey(), // always 1
  readAt: text("read_at").notNull(), // ISO timestamp
});

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationReadCursor = typeof notificationReadCursor.$inferSelect;

// ---------------------------------------------------------------------------
// Ticket read cursors
// ---------------------------------------------------------------------------

/**
 * Per-epic read cursor. Single-user local app: one row per epic, everything
 * up to last_read_at counts as read. No FK to epics — cursors are pure
 * bookkeeping and stale rows are harmless.
 */
export const ticketReadCursors = sqliteTable("ticket_read_cursors", {
  epicId: text("epic_id").primaryKey(),
  lastReadAt: text("last_read_at").notNull(), // ISO timestamp
  updatedAt: text("updated_at").notNull(), // ISO timestamp
});

export type TicketReadCursor = typeof ticketReadCursors.$inferSelect;
export type NewTicketReadCursor = typeof ticketReadCursors.$inferInsert;

// ---------------------------------------------------------------------------
// Provider usage snapshots
// ---------------------------------------------------------------------------

// Latest provider-reported rate-limit snapshot per provider (see migration
// 0027). captured_at = provider event time (ISO UTC); resets_at = unix
// SECONDS as emitted; raw_json = the full rate_limits object.
export const providerUsageSnapshots = sqliteTable("provider_usage_snapshots", {
  provider: text("provider").primaryKey(),
  capturedAt: text("captured_at").notNull(),
  planType: text("plan_type"),
  primaryUsedPercent: real("primary_used_percent"),
  primaryWindowMinutes: integer("primary_window_minutes"),
  primaryResetsAt: integer("primary_resets_at"),
  secondaryUsedPercent: real("secondary_used_percent"),
  secondaryWindowMinutes: integer("secondary_window_minutes"),
  secondaryResetsAt: integer("secondary_resets_at"),
  sourceFile: text("source_file"),
  rawJson: text("raw_json").notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

export type ProviderUsageSnapshot = typeof providerUsageSnapshots.$inferSelect;
export type NewProviderUsageSnapshot = typeof providerUsageSnapshots.$inferInsert;
