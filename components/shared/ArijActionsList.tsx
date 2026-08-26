"use client";

import { Card } from "@/components/ui/card";
import {
  ArrowRightLeft,
  ClipboardList,
  HelpCircle,
  ImageIcon,
  MessageSquare,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Client-side mirror of lib/agent-sessions/arij-actions.ts#ArijAction
 * (the session detail API returns these as plain JSON).
 */
export interface ArijActionItem {
  kind:
    | "status_change"
    | "comment"
    | "question"
    | "findings"
    | "artifact"
    | "tool_call";
  summary: string;
  detail?: string;
  at: string | null;
}

/**
 * Icon per action kind. Exported so the ticket panel's "What the agent did"
 * block renders the same visual vocabulary as this list.
 */
export const ARIJ_ACTION_ICONS: Record<ArijActionItem["kind"], LucideIcon> = {
  status_change: ArrowRightLeft,
  comment: MessageSquare,
  question: HelpCircle,
  findings: ClipboardList,
  artifact: ImageIcon,
  tool_call: Wrench,
};

/**
 * Token-based color per action kind (no raw hex — the cassette palette drives
 * these through CSS custom properties).
 */
export const ARIJ_ACTION_COLORS: Record<ArijActionItem["kind"], string> = {
  status_change: "text-agent",
  comment: "text-muted-foreground",
  question: "text-priority-yellow",
  findings: "text-agent",
  artifact: "text-agent",
  tool_call: "text-meta",
};

export function arijActionIcon(kind: ArijActionItem["kind"]): LucideIcon {
  return ARIJ_ACTION_ICONS[kind] ?? Wrench;
}

export function arijActionColor(kind: ArijActionItem["kind"]): string {
  return ARIJ_ACTION_COLORS[kind] ?? "text-muted-foreground";
}

export function formatArijActionTime(at: string | null): string | null {
  if (!at) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString();
}

/**
 * Compact "Arij actions" list on the session detail page: the structured
 * effects the agent had on the board (status changes, comments, questions,
 * review findings, visual proofs, MCP tool calls). Renders nothing when there are none —
 * sessions without MCP injection stay visually unchanged.
 */
export function ArijActionsList({ actions }: { actions?: ArijActionItem[] | null }) {
  if (!actions || actions.length === 0) return null;

  return (
    <Card className="mb-6 rounded-[11px] p-4" data-testid="arij-actions">
      <h3 className="mb-3 text-[11.5px] uppercase tracking-[.08em] text-meta">
        Arij actions
      </h3>
      <ul className="space-y-2">
        {actions.map((action, idx) => {
          const Icon = arijActionIcon(action.kind);
          const color = arijActionColor(action.kind);
          const time = formatArijActionTime(action.at);
          return (
            <li
              key={idx}
              className="flex items-start gap-2 text-[13px]"
              data-testid={`arij-action-${action.kind}`}
            >
              <Icon className={`mt-0.5 h-[13px] w-[13px] shrink-0 ${color}`} />
              <div className="min-w-0 flex-1">
                <span>{action.summary}</span>
                {action.detail && (
                  <p className="truncate text-[12px] text-muted-foreground">
                    {action.detail}
                  </p>
                )}
              </div>
              {time && (
                <span className="shrink-0 font-mono text-[11px] text-meta">
                  {time}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
