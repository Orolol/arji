import { NextRequest, NextResponse } from "next/server";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import {
  getProjectMemoryArchiveDoc,
  saveProjectMemory,
} from "@/lib/documents/memory";
import { PROJECT_MEMORY_MAX_CHARS } from "@/lib/documents/memory-constants";
import {
  getMemoryWriteProvenance,
  recordMemoryWriteProvenance,
} from "@/lib/documents/memory-provenance";
import { eventBus } from "@/lib/events/bus";
import { getPendingMemoryWriter } from "@/lib/workflow/memory-writer-lock";
import { createMemoryManualWriteNotification } from "@/lib/notifications/create";

type Params = { params: Promise<{ projectId: string }> };

/**
 * POST /api/projects/[projectId]/memory/restore
 *
 * Story 5 of the "gérer la section mémoire" epic: puts back the pre-dream
 * snapshot (the MEMORY_ARCHIVE document that `replaceProjectMemoryWithSnapshot`
 * takes atomically before a dream rewrites the memory) in one click.
 *
 * It is a MANUAL write — not a dream undo path that agents may touch:
 * - the restore is UNCONDITIONAL on purpose. If a Dreaming or distillation
 *   rewrite is in flight when the user clicks restore, that write will later
 *   hit the optimistic guard (the memory content no longer matches what it
 *   reasoned from), drop its own output, and notify the user that the manual
 *   content was kept. The user just clicked the button: they win.
 * - restoring writes provenance "manual" and emits the SAME `memory:changed`
 *   event as every other write, so open panels re-fetch through one channel
 *   and the activity feed shows the restore as a first-class event.
 *
 * 404s when there is no snapshot yet (nothing to restore).
 */
export async function POST(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const archive = getProjectMemoryArchiveDoc(projectId);
  if (!archive) {
    return NextResponse.json(
      { error: "No memory snapshot to restore yet" },
      { status: 404 }
    );
  }

  const { doc } = saveProjectMemory(
    projectId,
    archive.markdownContent ?? ""
  );

  // Same bookkeeping as every manual memory write: provenance, one SSE event,
  // one activity entry (flagged "restored" so the feed says it was a restore).
  recordMemoryWriteProvenance(projectId, { source: "manual", sessionId: null });
  eventBus.emit({
    type: "memory:changed",
    projectId,
    data: { source: "manual", restored: true },
    timestamp: new Date().toISOString(),
  });
  createMemoryManualWriteNotification({ projectId, restored: true });

  return NextResponse.json({
    data: {
      content: doc.markdownContent ?? "",
      exists: true,
      updatedAt: doc.updatedAt ?? null,
      maxChars: PROJECT_MEMORY_MAX_CHARS,
      provenance: getMemoryWriteProvenance(projectId),
      archive: {
        content: archive.markdownContent ?? "",
        updatedAt: archive.updatedAt ?? null,
      },
      pendingWriter: getPendingMemoryWriter(projectId),
    },
  });
}
