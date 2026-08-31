import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import {
  getProjectMemoryDoc,
  getProjectMemoryArchiveDoc,
  saveProjectMemory,
} from "@/lib/documents/memory";
import {
  PROJECT_MEMORY_MAX_CHARS,
  PROJECT_MEMORY_MAX_TOKENS,
} from "@/lib/documents/memory-constants";
import {
  getMemoryWriteProvenance,
  recordMemoryWriteProvenance,
} from "@/lib/documents/memory-provenance";
import { eventBus } from "@/lib/events/bus";
import { getPendingMemoryWriter } from "@/lib/workflow/memory-writer-lock";
import { createMemoryManualWriteNotification } from "@/lib/notifications/create";

type Params = { params: Promise<{ projectId: string }> };

/**
 * The restore-from-snapshot payload the memory panel shows: the one pre-dream
 * archive row, or null when there is nothing to restore.
 */
function memoryArchivePayload(projectId: string) {
  const archive = getProjectMemoryArchiveDoc(projectId);
  return archive
    ? {
        content: archive.markdownContent ?? "",
        updatedAt: archive.updatedAt ?? null,
      }
    : null;
}

/**
 * GET /api/projects/[projectId]/memory
 *
 * The project's learned-memory document (see lib/documents/memory.ts).
 * `content` is an empty string when no memory document exists yet — the
 * memory panel treats "absent" and "empty" identically.
 *
 * `provenance` tells WHO wrote the document last (Story 3 of the "gérer la
 * section mémoire" epic), `archive` carries the one pre-dream snapshot the
 * panel can restore from, and `pendingWriter` names an in-flight agent
 * rewrite so the panel can warn that it may be superseded.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const doc = getProjectMemoryDoc(projectId);
  const provenance = getMemoryWriteProvenance(projectId);
  const archive = memoryArchivePayload(projectId);

  return NextResponse.json({
    data: {
      content: doc?.markdownContent ?? "",
      exists: !!doc,
      updatedAt: doc?.updatedAt ?? null,
      maxChars: PROJECT_MEMORY_MAX_CHARS,
      provenance,
      archive,
      pendingWriter: getPendingMemoryWriter(projectId),
    },
  });
}

const putMemorySchema = z.object({
  // The manual editor REJECTS oversized input (unlike the distillation flow,
  // which truncates) so a hand-written doc is never silently cut.
  content: z
    .string()
    .max(
      PROJECT_MEMORY_MAX_CHARS,
      `Project memory must stay under ${PROJECT_MEMORY_MAX_TOKENS} tokens (about ${PROJECT_MEMORY_MAX_CHARS} characters)`
    ),
});

/**
 * PUT /api/projects/[projectId]/memory
 *
 * Creates or replaces the memory document with the given markdown body.
 * An empty string is valid: it clears the memory (the prompt section is
 * omitted for empty content, so agents simply stop seeing it).
 */
export async function PUT(request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const validated = await validateBody(putMemorySchema, request);
  if (isValidationError(validated)) return validated;
  const { doc } = saveProjectMemory(projectId, validated.data.content);

  // Record who wrote the document, then tell every open Spec & Memory view to
  // re-fetch (story 2: no more polling), and leave an activity entry: manual
  // writes enter the project feed the same way agent writes do.
  recordMemoryWriteProvenance(projectId, { source: "manual", sessionId: null });
  eventBus.emit({
    type: "memory:changed",
    projectId,
    data: { source: "manual" },
    timestamp: new Date().toISOString(),
  });
  createMemoryManualWriteNotification({ projectId, restored: false });

  return NextResponse.json({
    data: {
      content: doc.markdownContent ?? "",
      exists: true,
      updatedAt: doc.updatedAt ?? null,
      maxChars: PROJECT_MEMORY_MAX_CHARS,
      provenance: getMemoryWriteProvenance(projectId),
      archive: memoryArchivePayload(projectId),
      pendingWriter: getPendingMemoryWriter(projectId),
    },
  });
}
