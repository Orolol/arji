"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { Mono, PillButton } from "@/components/piscine";
import { cn } from "@/lib/utils";

/**
 * The Discard / Save footer of frame 11c — one per draft-and-commit tab.
 *
 * Frame verbatim: outline h32 r9999 with a 1.5px `--action-outline` border,
 * filled h32 `--action` with a 13px lucide check. `PillButton size="lg"` is
 * exactly that geometry, and the filled Save is the ONE filled button on the
 * row.
 *
 * Progress is a WORD, never a spinner and never a colour: `PillButton`'s
 * `pending` swaps the label and sets `aria-busy`.
 */
export interface SettingsFooterProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  message?: string | null;
  messageTone?: "muted" | "danger";
  /** Disable both buttons outright — the settings read failed. */
  disabled?: boolean;
  className?: string;
}

export function SettingsFooter({
  dirty,
  saving,
  onSave,
  onDiscard,
  message,
  messageTone = "muted",
  disabled = false,
  className,
}: SettingsFooterProps) {
  const failed = messageTone === "danger";

  return (
    <div
      data-slot="settings-footer"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-[10px] px-[4px] pt-[2px]",
        className,
      )}
    >
      <Mono size={10.5} tone="muted">
        les changements s&apos;appliquent aux prochaines sessions
      </Mono>
      <div
        role={failed ? "alert" : "status"}
        aria-live="polite"
        data-testid="settings-message"
        className="min-w-0"
      >
        {message ? (
          <Mono size={10.5} tone={failed ? "danger" : "muted"}>
            {message}
          </Mono>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-[10px]">
        <PillButton
          variant="outline"
          outlineTone="action"
          size="lg"
          disabled={disabled || !dirty || saving}
          onClick={onDiscard}
          data-testid="settings-discard"
        >
          Discard
        </PillButton>
        <PillButton
          variant="filled"
          size="lg"
          icon={Check}
          disabled={disabled || !dirty}
          pending={saving}
          pendingLabel="Saving…"
          onClick={onSave}
          data-testid="settings-save"
        >
          Save
        </PillButton>
      </div>
    </div>
  );
}
