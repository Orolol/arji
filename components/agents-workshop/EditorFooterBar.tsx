"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, Trash2 } from "lucide-react";

import { Mono, PillButton, QuietDangerAction } from "@/components/piscine";
import { PermanentDeleteDialog } from "@/components/shared/PermanentDeleteDialog";
import { formatRelative } from "@/lib/i18n/format";
import type { UiLocale } from "@/lib/i18n/locales";

/**
 * The bare footer row: Delete · created-stamp · Discard · Save.
 *
 * ONE FILLED BUTTON IN THE ROW. Save is the deep water-green; Discard is an
 * action-outlined pill whose LABEL stays ink; Delete has no chrome at all, so
 * a destructive action never competes with the row's one commitment.
 *
 * NO `updated_at`. `named_agents` has only `created_at`, and adding a column
 * would mean a migration this work is not allowed to write — so the frame's
 * "last edited 3d ago" ships as an honest "created …". When `createdAt` is
 * null (legacy rows) nothing is rendered at all: "created —" would be a
 * sentence about a fact we do not have.
 *
 * The confirmation is the shared PermanentDeleteDialog, and its copy names the
 * one consequence a user cannot see: deleting an agent is a bare row delete,
 * safe only because both referencing columns are ON DELETE SET NULL — so
 * assignments silently fall back to the Arij default and escalation edges
 * pointing at it vanish.
 *
 * The age comes from `lib/i18n/format.ts` like every other relative stamp in
 * the interface — this row used to carry its own sixth copy of the rule.
 */

export interface EditorFooterBarProps {
  agentName: string;
  createdAt: string | null;
  dirty: boolean;
  saving: boolean;
  deleting: boolean;
  canSave: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onDelete: () => Promise<void>;
}

export function EditorFooterBar({
  agentName,
  createdAt,
  dirty,
  saving,
  deleting,
  canSave,
  error,
  onSave,
  onDiscard,
  onDelete,
}: EditorFooterBarProps) {
  const t = useTranslations("AgentsWorkshop");
  const locale = useLocale() as UiLocale;
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Empty when the stamp cannot be read (legacy rows): "created —" would be a
  // sentence about a fact we do not have, so the whole line is dropped.
  const created = createdAt ? formatRelative(createdAt, { locale }) : "";

  return (
    <div className="flex shrink-0 flex-col gap-1.5">
      {error ? (
        <p role="alert" className="px-1 font-sans text-[12px] text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-[10px] px-1">
        {/* The old trigger was an icon-only button and needed
            aria-label="Delete {name}"; this one carries its own visible label,
            which is the accessible name — the editor already says which agent
            is open, and a hidden name that differs from the visible one is a
            WCAG 2.5.3 problem rather than a fix. */}
        <QuietDangerAction
          icon={Trash2}
          size={12}
          onClick={() => setConfirmOpen(true)}
        >
          {t("editor.deleteAgent")}
        </QuietDangerAction>

        {created ? (
          <Mono size={10.5} tone="muted">
            {t("editor.created", { age: created })}
          </Mono>
        ) : null}

        <PillButton
          variant="outline"
          outlineTone="action"
          size="lg"
          className="ml-auto"
          onClick={onDiscard}
          disabled={!dirty || saving || deleting}
        >
          {t("editor.discard")}
        </PillButton>
        <PillButton
          variant="filled"
          size="lg"
          icon={Check}
          onClick={onSave}
          disabled={!canSave || deleting}
          pending={saving}
          pendingLabel={t("common.saving")}
        >
          {t("common.save")}
        </PillButton>
      </div>

      <PermanentDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("editor.deleteTitle")}
        description={t("editor.deleteDescription", { name: agentName })}
        confirmLabel={t("editor.deleteAgent")}
        deleting={deleting}
        onConfirm={async () => {
          await onDelete();
          setConfirmOpen(false);
        }}
      />
    </div>
  );
}
