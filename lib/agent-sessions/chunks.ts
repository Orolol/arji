import type Database from "better-sqlite3";
import { createId } from "@/lib/utils/nanoid";
import { sqlite } from "@/lib/db";

export type AgentSessionStreamType = "response" | "raw" | "output";

export interface SessionChunk {
  id: string;
  sessionId: string;
  streamType: AgentSessionStreamType;
  sequence: number;
  chunkKey: string | null;
  content: string;
  createdAt: string | null;
}

export interface AppendSessionChunkInput {
  sessionId: string;
  streamType: AgentSessionStreamType;
  content: string;
  chunkKey?: string | null;
  createdAt?: string;
}

export interface AppendSessionChunkResult {
  inserted: boolean;
  chunk: SessionChunk;
}

export interface SessionChunkStore {
  appendChunk: (input: AppendSessionChunkInput) => AppendSessionChunkResult;
  listChunks: (
    sessionId: string,
    streamType: AgentSessionStreamType
  ) => SessionChunk[];
}

interface ExistingChunkRow {
  id: string;
  sessionId: string;
  streamType: AgentSessionStreamType;
  sequence: number;
  chunkKey: string | null;
  content: string;
  createdAt: string | null;
}

interface SequenceRow {
  sequence: number;
}

export function extractLastNonEmptyText(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

export function createSessionChunkStore(
  database: Database.Database
): SessionChunkStore {
  const selectExistingByKeyStmt = database.prepare<
    [string, AgentSessionStreamType, string],
    ExistingChunkRow
  >(
    `SELECT
      id,
      session_id AS sessionId,
      stream_type AS streamType,
      sequence,
      chunk_key AS chunkKey,
      content,
      created_at AS createdAt
    FROM agent_session_chunks
    WHERE session_id = ? AND stream_type = ? AND chunk_key = ?
    LIMIT 1`
  );

  const reserveSequenceStmt = database.prepare<
    [string, string],
    SequenceRow
  >(
    `INSERT INTO agent_session_sequences (session_id, next_sequence, updated_at)
     VALUES (?, 2, ?)
     ON CONFLICT(session_id) DO UPDATE
       SET next_sequence = next_sequence + 1,
           updated_at = excluded.updated_at
     RETURNING next_sequence - 1 AS sequence`
  );

  const insertChunkStmt = database.prepare<
    [string, string, AgentSessionStreamType, number, string | null, string, string]
  >(
    `INSERT INTO agent_session_chunks (
      id,
      session_id,
      stream_type,
      sequence,
      chunk_key,
      content,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const listChunksStmt = database.prepare<
    [string, AgentSessionStreamType],
    SessionChunk
  >(
    `SELECT
      id,
      session_id AS sessionId,
      stream_type AS streamType,
      sequence,
      chunk_key AS chunkKey,
      content,
      created_at AS createdAt
    FROM agent_session_chunks
    WHERE session_id = ? AND stream_type = ?
    ORDER BY sequence ASC`
  );

  const updateLastNonEmptyTextStmt = database.prepare<[string, string]>(
    `UPDATE agent_sessions
     SET last_non_empty_text = ?
     WHERE id = ?`
  );

  const appendChunkTx = database.transaction(
    (input: AppendSessionChunkInput): AppendSessionChunkResult => {
      const createdAt = input.createdAt ?? new Date().toISOString();
      const chunkKey = input.chunkKey ?? null;

      if (chunkKey) {
        const existing = selectExistingByKeyStmt.get(
          input.sessionId,
          input.streamType,
          chunkKey
        );
        if (existing) {
          return {
            inserted: false,
            chunk: existing,
          };
        }
      }

      const sequenceRow = reserveSequenceStmt.get(input.sessionId, createdAt);
      if (!sequenceRow) {
        throw new Error(
          `Failed to reserve sequence for session ${input.sessionId}`
        );
      }

      const chunk: SessionChunk = {
        id: createId(),
        sessionId: input.sessionId,
        streamType: input.streamType,
        sequence: sequenceRow.sequence,
        chunkKey,
        content: input.content,
        createdAt,
      };

      insertChunkStmt.run(
        chunk.id,
        chunk.sessionId,
        chunk.streamType,
        chunk.sequence,
        chunk.chunkKey,
        chunk.content,
        chunk.createdAt ?? createdAt
      );

      if (
        input.streamType === "output" ||
        input.streamType === "response"
      ) {
        const lastNonEmptyText = extractLastNonEmptyText(input.content);
        if (lastNonEmptyText) {
          updateLastNonEmptyTextStmt.run(lastNonEmptyText, input.sessionId);
        }
      }

      return {
        inserted: true,
        chunk,
      };
    }
  );

  return {
    appendChunk(input: AppendSessionChunkInput): AppendSessionChunkResult {
      return appendChunkTx(input);
    },
    listChunks(
      sessionId: string,
      streamType: AgentSessionStreamType
    ): SessionChunk[] {
      return listChunksStmt.all(sessionId, streamType);
    },
  };
}

let defaultStore: SessionChunkStore | null = null;

function getDefaultStore(): SessionChunkStore {
  if (!defaultStore) {
    defaultStore = createSessionChunkStore(sqlite);
  }
  return defaultStore;
}

export function appendSessionChunk(
  input: AppendSessionChunkInput
): AppendSessionChunkResult {
  return getDefaultStore().appendChunk(input);
}

export function listSessionChunks(
  sessionId: string,
  streamType: AgentSessionStreamType
): SessionChunk[] {
  return getDefaultStore().listChunks(sessionId, streamType);
}
