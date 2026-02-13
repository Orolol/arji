import fs from "fs";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";
import { extractLastNonEmptyText } from "@/lib/agent-sessions/chunks";

export interface BackfillRecentSessionsInput {
  projectId?: string;
  limit?: number;
}

export interface BackfillRecentSessionsResult {
  scanned: number;
  backfilled: number;
  skippedNoLogs: number;
  skippedNoText: number;
  errors: number;
}

interface BackfillDependencies {
  db: typeof db;
  existsSync: typeof fs.existsSync;
  readFileSync: typeof fs.readFileSync;
}

const defaultDependencies: BackfillDependencies = {
  db,
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
};

const backfilledProjects = new Set<string>();

export function extractLastNonEmptyFromLogPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const source = payload as { result?: unknown; error?: unknown };
  if (typeof source.result === "string") {
    return extractLastNonEmptyText(source.result);
  }
  if (typeof source.error === "string") {
    return extractLastNonEmptyText(source.error);
  }
  return null;
}

export function backfillRecentSessionLastNonEmptyText(
  { projectId, limit = 200 }: BackfillRecentSessionsInput = {},
  dependencies: BackfillDependencies = defaultDependencies
): BackfillRecentSessionsResult {
  const whereConditions = [isNull(agentSessions.lastNonEmptyText)];
  if (projectId) {
    whereConditions.push(eq(agentSessions.projectId, projectId));
  }

  const sessions = dependencies.db
    .select({
      id: agentSessions.id,
      logsPath: agentSessions.logsPath,
    })
    .from(agentSessions)
    .where(and(...whereConditions))
    .orderBy(desc(agentSessions.createdAt))
    .limit(limit)
    .all();

  const result: BackfillRecentSessionsResult = {
    scanned: sessions.length,
    backfilled: 0,
    skippedNoLogs: 0,
    skippedNoText: 0,
    errors: 0,
  };

  for (const session of sessions) {
    if (!session.logsPath || !dependencies.existsSync(session.logsPath)) {
      result.skippedNoLogs += 1;
      continue;
    }

    let parsed: unknown;
    try {
      const raw = dependencies.readFileSync(session.logsPath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      result.errors += 1;
      continue;
    }

    const lastNonEmptyText = extractLastNonEmptyFromLogPayload(parsed);
    if (!lastNonEmptyText) {
      result.skippedNoText += 1;
      continue;
    }

    dependencies.db
      .update(agentSessions)
      .set({ lastNonEmptyText })
      .where(eq(agentSessions.id, session.id))
      .run();

    result.backfilled += 1;
  }

  return result;
}

export function runBackfillRecentSessionLastNonEmptyTextOnce(
  projectId: string
): void {
  if (backfilledProjects.has(projectId)) {
    return;
  }
  backfilledProjects.add(projectId);

  try {
    backfillRecentSessionLastNonEmptyText({ projectId, limit: 200 });
  } catch (error) {
    console.error(
      `[sessions/backfill] Failed to backfill lastNonEmptyText for project ${projectId}`,
      error
    );
  }
}
