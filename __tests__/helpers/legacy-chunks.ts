/**
 * Seed `agent_session_chunks` rows STRAIGHT into the table, past
 * `appendChunk`.
 *
 * The write-path cap (`SESSION_CHUNK_MAX_STORED_BYTES`) means no chunk written
 * from now on can be oversized, so a fixture built through the store can no
 * longer produce one. The oversized rows several read-path tests are about are
 * the ones ALREADY in the live database — 19 over 1 MB, one of 8.3 MB, all
 * written before the cap existed — and the bounded read, the scan budget and
 * the offset cursor all still have to handle them. Seeding around the store is
 * what keeps those tests about the READ rather than about the write cap.
 *
 * `lastNonEmptyText` is mirrored the way the store would have written it at the
 * time — from the full, uncapped content — so a legacy session's derived
 * columns match the rows.
 *
 * Lives in `__tests__/helpers/` on purpose: vitest's include glob is
 * `**\/*.test.{ts,tsx,mjs}`, so nothing here is collected as a test.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  agentSessionChunks,
  agentSessionSequences,
  agentSessions,
} from "@/lib/db/schema";
import { extractLastNonEmptyText } from "@/lib/agent-sessions/last-text";

export type ChunkStreamType = "raw" | "output" | "response";

export function seedLegacyChunks(
  sessionId: string,
  streamType: ChunkStreamType,
  contents: string[]
): void {
  // Continue the session's existing numbering: `agent_session_chunks` has a
  // UNIQUE (session_id, sequence), and a fixture usually mixes store-written
  // and legacy rows.
  const highest = db
    .select({ max: sql<number | null>`max(${agentSessionChunks.sequence})` })
    .from(agentSessionChunks)
    .where(eq(agentSessionChunks.sessionId, sessionId))
    .get();
  let sequence = (highest?.max ?? 0) + 1;

  for (const content of contents) {
    db.insert(agentSessionChunks)
      .values({
        id: `legacy-${sessionId}-${streamType}-${sequence}`,
        sessionId,
        streamType,
        sequence,
        content,
        createdAt: new Date().toISOString(),
      })
      .run();

    if (streamType === "output" || streamType === "response") {
      const lastNonEmptyText = extractLastNonEmptyText(content);
      if (lastNonEmptyText) {
        db.update(agentSessions)
          .set({ lastNonEmptyText })
          .where(eq(agentSessions.id, sessionId))
          .run();
      }
    }
    sequence += 1;
  }

  // Push the store's own counter past the rows just written. Fixtures mix the
  // two — `seedChunks(...)` before AND after a legacy row is the normal shape —
  // and `agent_session_chunks` has a UNIQUE (session_id, sequence), so a store
  // write that resumed from its old counter would collide.
  db.insert(agentSessionSequences)
    .values({
      sessionId,
      nextSequence: sequence,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: agentSessionSequences.sessionId,
      set: {
        nextSequence: sql`max(${agentSessionSequences.nextSequence}, excluded.next_sequence)`,
      },
    })
    .run();
}
