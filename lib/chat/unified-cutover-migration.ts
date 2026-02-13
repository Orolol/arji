import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { sqlite } from "@/lib/db";
import { createId } from "@/lib/utils/nanoid";

type Logger = Pick<Console, "info" | "error">;

interface CutoverMigrationDependencies {
  sqlite: Database.Database;
  dataDir: string;
  createId: () => string;
  now: () => Date;
  fs: Pick<typeof fs, "mkdirSync" | "writeFileSync">;
  logger: Logger;
}

interface ConversationRow {
  id: string;
  project_id: string;
  type: string;
  label: string;
  status: string | null;
  epic_id: string | null;
  provider: string | null;
  created_at: string | null;
}

interface MessageRow {
  id: string;
  project_id: string;
  conversation_id: string | null;
  role: string;
  content: string;
  metadata: string | null;
  created_at: string | null;
}

interface AttachmentRow {
  id: string;
  chat_message_id: string | null;
  file_name: string;
  file_path: string;
  mime_type: string;
  size_bytes: number;
  created_at: string | null;
}

interface CutoverSnapshot {
  conversations: ConversationRow[];
  messages: MessageRow[];
  attachments: AttachmentRow[];
}

interface CutoverIntegritySummary {
  missingConversationReferences: number;
  duplicateConversationIds: number;
  duplicateMessageIds: number;
  zeroMissingConversations: boolean;
  zeroDuplicateConversations: boolean;
  zeroDuplicateMessages: boolean;
}

interface CutoverCountSummary {
  conversations: number;
  messages: number;
  attachments: number;
  orphanMessages: number;
}

interface CutoverActionSummary {
  createdFallbackConversation: boolean;
  fallbackConversationId: string | null;
  messagesReassigned: number;
}

export interface UnifiedChatCutoverMigrationReport {
  migrationId: string;
  projectId: string;
  startedAt: string;
  completedAt: string;
  backupPath: string;
  reportPath: string;
  before: CutoverCountSummary;
  actions: CutoverActionSummary;
  after: CutoverCountSummary;
  integrity: CutoverIntegritySummary;
}

const defaultDependencies: CutoverMigrationDependencies = {
  sqlite,
  dataDir: path.join(process.cwd(), "data"),
  createId,
  now: () => new Date(),
  fs: {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
  },
  logger: console,
};

const migratedProjects = new Set<string>();

function toMigrationId(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function readSnapshot(
  sqliteClient: Database.Database,
  projectId: string,
): CutoverSnapshot {
  const conversations = sqliteClient
    .prepare(
      `SELECT id, project_id, type, label, status, epic_id, provider, created_at
       FROM chat_conversations
       WHERE project_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(projectId) as ConversationRow[];

  const messages = sqliteClient
    .prepare(
      `SELECT id, project_id, conversation_id, role, content, metadata, created_at
       FROM chat_messages
       WHERE project_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(projectId) as MessageRow[];

  const attachments = sqliteClient
    .prepare(
      `SELECT a.id, a.chat_message_id, a.file_name, a.file_path, a.mime_type, a.size_bytes, a.created_at
       FROM chat_attachments a
       JOIN chat_messages m ON m.id = a.chat_message_id
       WHERE m.project_id = ?
       ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all(projectId) as AttachmentRow[];

  return {
    conversations,
    messages,
    attachments,
  };
}

function summarizeCounts(snapshot: CutoverSnapshot): CutoverCountSummary {
  return {
    conversations: snapshot.conversations.length,
    messages: snapshot.messages.length,
    attachments: snapshot.attachments.length,
    orphanMessages: snapshot.messages.filter(
      (message) => message.conversation_id === null,
    ).length,
  };
}

function countDuplicates(rows: ReadonlyArray<{ id: string }>): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const row of rows) {
    if (seen.has(row.id)) {
      duplicates += 1;
      continue;
    }
    seen.add(row.id);
  }
  return duplicates;
}

function computeIntegritySummary(
  sqliteClient: Database.Database,
  projectId: string,
  after: CutoverSnapshot,
): CutoverIntegritySummary {
  const missingRow = sqliteClient
    .prepare(
      `SELECT COUNT(*) AS count
       FROM chat_messages m
       LEFT JOIN chat_conversations c ON c.id = m.conversation_id
       WHERE m.project_id = ?
         AND (
           m.conversation_id IS NULL
           OR c.id IS NULL
           OR c.project_id != m.project_id
         )`,
    )
    .get(projectId) as { count: number };

  const duplicateConversationIds = countDuplicates(after.conversations);
  const duplicateMessageIds = countDuplicates(after.messages);

  return {
    missingConversationReferences: missingRow.count,
    duplicateConversationIds,
    duplicateMessageIds,
    zeroMissingConversations: missingRow.count === 0,
    zeroDuplicateConversations: duplicateConversationIds === 0,
    zeroDuplicateMessages: duplicateMessageIds === 0,
  };
}

function ensureMigrationDir(
  dependencies: CutoverMigrationDependencies,
  projectId: string,
): string {
  const projectDir = path.join(
    dependencies.dataDir,
    "migrations",
    "unified-chat-cutover",
    projectId,
  );
  dependencies.fs.mkdirSync(projectDir, { recursive: true });
  return projectDir;
}

export function runUnifiedChatCutoverMigration(
  projectId: string,
  providedDependencies: Partial<CutoverMigrationDependencies> = {},
): UnifiedChatCutoverMigrationReport {
  const dependencies: CutoverMigrationDependencies = {
    ...defaultDependencies,
    ...providedDependencies,
    fs: {
      ...defaultDependencies.fs,
      ...providedDependencies.fs,
    },
    logger: providedDependencies.logger ?? defaultDependencies.logger,
  };

  const startedAtDate = dependencies.now();
  const startedAt = startedAtDate.toISOString();
  const migrationId = toMigrationId(startedAtDate);
  const migrationDir = ensureMigrationDir(dependencies, projectId);
  const backupPath = path.join(migrationDir, `${migrationId}-backup.json`);
  const reportPath = path.join(migrationDir, `${migrationId}-report.json`);

  const before = readSnapshot(dependencies.sqlite, projectId);
  const beforeCounts = summarizeCounts(before);

  dependencies.fs.writeFileSync(
    backupPath,
    `${JSON.stringify(
      {
        migrationId,
        projectId,
        capturedAt: startedAt,
        snapshot: before,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  const actions: CutoverActionSummary = {
    createdFallbackConversation: false,
    fallbackConversationId: null,
    messagesReassigned: 0,
  };

  const migrate = dependencies.sqlite.transaction(() => {
    const orphanRows = dependencies.sqlite
      .prepare(
        `SELECT id, created_at
         FROM chat_messages
         WHERE project_id = ?
           AND conversation_id IS NULL
         ORDER BY created_at ASC, id ASC`,
      )
      .all(projectId) as Array<{ id: string; created_at: string | null }>;

    if (orphanRows.length === 0) {
      return;
    }

    const existingConversation = dependencies.sqlite
      .prepare(
        `SELECT id
         FROM chat_conversations
         WHERE project_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      )
      .get(projectId) as { id: string } | undefined;

    let fallbackConversationId = existingConversation?.id ?? null;

    if (!fallbackConversationId) {
      fallbackConversationId = dependencies.createId();
      const fallbackCreatedAt =
        orphanRows[0]?.created_at ?? dependencies.now().toISOString();
      dependencies.sqlite
        .prepare(
          `INSERT INTO chat_conversations (
              id,
              project_id,
              type,
              label,
              status,
              epic_id,
              provider,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fallbackConversationId,
          projectId,
          "brainstorm",
          "Brainstorm",
          "active",
          null,
          "claude-code",
          fallbackCreatedAt,
        );
      actions.createdFallbackConversation = true;
    }

    const reassigned = dependencies.sqlite
      .prepare(
        `UPDATE chat_messages
         SET conversation_id = ?
         WHERE project_id = ?
           AND conversation_id IS NULL`,
      )
      .run(fallbackConversationId, projectId);

    actions.fallbackConversationId = fallbackConversationId;
    actions.messagesReassigned = reassigned.changes ?? 0;
  });

  migrate();

  const after = readSnapshot(dependencies.sqlite, projectId);
  const afterCounts = summarizeCounts(after);
  const integrity = computeIntegritySummary(dependencies.sqlite, projectId, after);
  const completedAt = dependencies.now().toISOString();

  const report: UnifiedChatCutoverMigrationReport = {
    migrationId,
    projectId,
    startedAt,
    completedAt,
    backupPath,
    reportPath,
    before: beforeCounts,
    actions,
    after: afterCounts,
    integrity,
  };

  dependencies.fs.writeFileSync(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf-8",
  );

  dependencies.logger.info(
    `[chat/cutover] Migration ${migrationId} for project ${projectId}: ` +
      `reassigned ${actions.messagesReassigned} orphan message(s), ` +
      `missing refs ${integrity.missingConversationReferences}, ` +
      `duplicate conversations ${integrity.duplicateConversationIds}, ` +
      `duplicate messages ${integrity.duplicateMessageIds}`,
  );

  return report;
}

export function runUnifiedChatCutoverMigrationOnce(
  projectId: string,
  providedDependencies: Partial<CutoverMigrationDependencies> = {},
): UnifiedChatCutoverMigrationReport | null {
  if (migratedProjects.has(projectId)) {
    return null;
  }

  try {
    const report = runUnifiedChatCutoverMigration(projectId, providedDependencies);
    migratedProjects.add(projectId);
    return report;
  } catch (error) {
    const logger = providedDependencies.logger ?? defaultDependencies.logger;
    logger.error(
      `[chat/cutover] Migration failed for project ${projectId}`,
      error,
    );
    return null;
  }
}

export function resetUnifiedChatCutoverMigrationStateForTests() {
  migratedProjects.clear();
}
