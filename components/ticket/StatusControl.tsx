"use client";

/**
 * The workflow-aware status control, plus priority.
 *
 * Frame 6a draws no status control — it draws the pipeline chain, which is a
 * read-out, not a control. The control is nonetheless mandatory (moving a
 * ticket by hand is a core capability), and its home is the PIPELINE card's
 * label row.
 *
 * `ticketStatusOptions` renders EVERY board column, including the disabled
 * ones: the menu doubles as a map of what is reachable. Disabled entries
 * carry the engine's reason as their `title`. The workflow engine stays the
 * server-side source of truth, and its rejection surfaces inline under the
 * chain as `statusError` — the client list only mirrors the rules it can
 * evaluate on its own.
 *
 * The priority select has no slot of its own in the frame (a second pill
 * would exceed the screen's control budget), so it lives in this same menu
 * under a separator rather than being silently lost.
 */

import { useTranslations } from "next-intl";

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { SelectPill } from "@/components/piscine";
import { ticketStatusOptions } from "@/lib/kanban/status-transitions";
import { COLUMN_LABEL_KEYS, PRIORITY_LABEL_KEYS, type KanbanStatus } from "@/lib/types/kanban";

export interface StatusControlProps {
  status: string;
  priority: number;
  hasRunningSession: boolean;
  onStatusChange: (next: string) => void;
  onPriorityChange: (next: number) => void;
}

export function StatusControl({
  status,
  priority,
  hasRunningSession,
  onStatusChange,
  onPriorityChange,
}: StatusControlProps) {
  const tKey = useTranslations();
  const t = useTranslations("Ticket");
  // "(current)" is plain sans, so it lives under the system's 11px floor —
  // the 9.5px exception is for uppercase tracked mono kickers only, which
  // this is not.
  const options = ticketStatusOptions(status, { hasRunningSession }).map((option) => ({
    ...option,
    label: tKey(option.labelKey),
    disabledReason: option.disabledReasonKey ? tKey(option.disabledReasonKey, {
      status: COLUMN_LABEL_KEYS[status as KanbanStatus] ? tKey(COLUMN_LABEL_KEYS[status as KanbanStatus]) : status,
    }) : null,
  }));

  /**
   * Radix `Select` portals the selected item's ItemText children into the
   * trigger's value node whenever `<SelectValue>` has no children of its own.
   * The items carry a "(current)" marker inside their text, so without an
   * explicit value the closed trigger read "Review (current)".
   *
   * This trigger is a `SelectPill` (a DropdownMenu), whose label is explicit
   * by construction — but the derivation stays, and stays exactly this
   * expression: reverting the trigger to a Radix `Select` without it
   * reintroduces "Review (current)" in the closed state. This is a real bug
   * fix, not dead code.
   */
  const currentStatusLabel =
    options.find((option) => option.isCurrent)?.label ?? status ?? "";

  return (
    <span data-testid="ticket-status-control" className="ml-auto">
      <SelectPill label={currentStatusLabel} tone="ink" fill="card">
        <DropdownMenuLabel>{t("status.statusHeading")}</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.status}
            disabled={!option.enabled}
            title={option.isCurrent ? undefined : option.disabledReason ?? undefined}
            onSelect={() => {
              if (!option.enabled) return;
              onStatusChange(option.status);
            }}
          >
            <span className="flex items-center gap-2">
              <span>{option.label}</span>
              {option.isCurrent ? (
                <span className="text-[11px] font-normal text-muted-foreground">
                  {t("status.current")}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("status.priorityHeading")}</DropdownMenuLabel>
        {Object.entries(PRIORITY_LABEL_KEYS).map(([value, label]) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => onPriorityChange(Number(value))}
          >
            <span className="flex items-center gap-2">
              <span>{tKey(label)}</span>
              {Number(value) === priority ? (
                <span className="text-[11px] font-normal text-muted-foreground">
                  {t("status.current")}
                </span>
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}
      </SelectPill>
    </span>
  );
}
