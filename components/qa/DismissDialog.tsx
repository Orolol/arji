"use client";

import * as React from "react";

import { GhostInputPill, PillButton } from "@/components/piscine";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QaFinding } from "@/lib/qa/types";

import { FindingSeverityStamp } from "./FindingSeverityStamp";

/**
 * "Dismiss ce finding" — one line saying why, then the write.
 *
 * WHERE THE REASON GOES, AND WHY IT GOES THERE. `review_comments` is
 * `id, epicId, filePath, lineNumber, body, author, status, agentSessionId,
 * createdAt, updatedAt` and `status` is `open | resolved`. There is NO
 * dismissal-reason column, no `dismissed` status and no dismissal table, and
 * this packet may not add one (migrations are hand-written and out of scope).
 *
 * So the reason is appended to the finding's own `body`, which is the one free
 * text column the row has, through the PATCH route that already accepts both
 * `body` and `status`. Three facts make the append harmless:
 *   - `blocksMergeSql` and `blockingFindingSeverity` match on the LEADING
 *     prefix only (`SUBSTR(body,1,n) = '[critical]'`), so appending to the tail
 *     cannot reclassify the row;
 *   - the next reviewer's prompt lists `status = 'open'` rows only, so a
 *     dismissed row never re-enters a prompt;
 *   - `resolved` is exactly what the merge itself would have written — the
 *     merge IS the approval and resolves what remains.
 *
 * A `dismissed_reason` column (plus a `dismissed` status distinct from
 * `resolved`) is the correct fix, and is what someone writing migrations
 * anyway should add.
 *
 * THE CONFIRM IS DISABLED UNTIL THE REASON IS NON-EMPTY. An empty reason is a
 * silently-lost finding.
 */
export interface DismissDialogProps {
  finding: QaFinding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (finding: QaFinding, reason: string) => void | Promise<void>;
  pending?: boolean;
}

export function DismissDialog({
  finding,
  open,
  onOpenChange,
  onConfirm,
  pending = false,
}: DismissDialogProps) {
  const [reason, setReason] = React.useState("");

  // A new finding is a new reason: never carry the previous one over.
  React.useEffect(() => {
    setReason("");
  }, [finding?.findingId, open]);

  const submit = () => {
    const trimmed = reason.trim();
    if (!finding || trimmed.length === 0) return;
    void onConfirm(finding, trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="qa-dismiss-dialog"
        // No shadow: the ticket overlay is the only shadow in the system.
        className="gap-3 rounded-[16px] border-[1.5px] border-border bg-card p-[18px] shadow-none sm:max-w-[440px]"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-[15px] font-bold text-foreground">
            Dismiss ce finding
          </DialogTitle>
        </DialogHeader>

        {finding ? (
          <div className="flex items-start gap-2">
            <FindingSeverityStamp
              tier={finding.tier}
              label={finding.severityLabel}
              className="mt-[2px]"
            />
            <span className="min-w-0 flex-1 font-sans text-[13px] text-foreground">
              {finding.text}
            </span>
          </div>
        ) : null}

        <GhostInputPill
          value={reason}
          onChange={setReason}
          onSubmit={submit}
          placeholder="Pourquoi ? une ligne suffit…"
          fill="field"
          width="flex"
          disabled={pending}
          aria-label="Pourquoi ? une ligne suffit…"
          data-testid="qa-dismiss-reason"
        />

        <DialogFooter className="gap-2">
          <PillButton
            variant="outline"
            outlineTone="neutral"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="qa-dismiss-cancel"
          >
            Annuler
          </PillButton>
          <PillButton
            variant="filled"
            size="sm"
            onClick={submit}
            disabled={reason.trim().length === 0}
            pending={pending}
            pendingLabel="Dismiss…"
            data-testid="qa-dismiss-confirm"
          >
            Dismiss
          </PillButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
