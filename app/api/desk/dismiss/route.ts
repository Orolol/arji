import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deskDismissals } from "@/lib/db/schema";
import { dismissDeskSignalSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

/**
 * POST /api/desk/dismiss { epicId, kind, signalAt } — wave off a "Your turn" row.
 *
 * This DISMISSES A SIGNAL, NOT A TICKET. It writes one bookkeeping row and
 * touches nothing else: no ticket status, no transition service, no activity
 * entry. The desk's coral stratum is derived, so hiding a row is a read-side
 * concern and must not look like a workflow decision in the audit trail.
 *
 * `signalAt` is stored as the dismissed signal's own timestamp, so
 * `applyDeskDismissals` can bring the row back the moment a NEWER question,
 * failure or conflict lands on the same epic.
 *
 * Like `/api/inbox/read`, the epic's existence is deliberately not checked:
 * dismissals carry no FK, and a row left behind by a deleted epic is inert.
 */
export async function POST(request: NextRequest) {
  const validated = await validateBody(dismissDeskSignalSchema, request);
  if (isValidationError(validated)) return validated;

  const { epicId, kind, signalAt = null } = validated.data;
  const now = new Date().toISOString();

  db.insert(deskDismissals)
    .values({ epicId, kind, signalAt, dismissedAt: now })
    .onConflictDoUpdate({
      // One dismissal per (epic, family): re-arming replaces the stored signal
      // rather than accumulating rows.
      target: [deskDismissals.epicId, deskDismissals.kind],
      set: { signalAt, dismissedAt: now },
    })
    .run();

  return NextResponse.json({ data: { ok: true, epicId, kind, signalAt, dismissedAt: now } });
}
