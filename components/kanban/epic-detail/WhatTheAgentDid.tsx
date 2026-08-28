"use client";

import { useEffect, useState } from "react";
import {
  arijActionColor,
  arijActionIcon,
  formatArijActionTime,
  type ArijActionItem,
} from "@/components/shared/ArijActionsList";
import { fetchUnifiedSessions } from "@/lib/agent-sessions/session-list";

interface WhatTheAgentDidProps {
  projectId: string;
  epicId: string | null;
  /**
   * Changing this re-fetches — the parent passes the active session id so the
   * block refreshes when an agent starts or finishes on this ticket.
   */
  refreshToken?: string | null;
}

interface UnifiedSessionRow {
  id: string;
  kind?: string;
  epicId?: string | null;
  createdAt?: string | null;
}

/**
 * "What the agent did" — the structured board effects of the newest agent
 * session on this ticket, rendered on the agent surface inside the ticket
 * panel. Same data and icon vocabulary as the session detail page's
 * `ArijActionsList`; renders nothing when the session recorded no actions
 * (or when there is no agent session yet), so tickets that never ran an
 * agent stay visually unchanged.
 *
 * Durable effects only — status changes, comments, questions, findings and
 * artifacts, all of which come from indexed session-scoped reads. The session
 * detail page additionally scans the raw stream (`?view=arij-actions`) for
 * read-only calls and calls the board refused; that scan is worth paging
 * through on a page dedicated to one session, but not on an ambient block
 * inside the ticket panel.
 */
export function WhatTheAgentDid({
  projectId,
  epicId,
  refreshToken,
}: WhatTheAgentDidProps) {
  const [actions, setActions] = useState<ArijActionItem[]>([]);

  useEffect(() => {
    let cancelled = false;

    if (!epicId) {
      setActions([]);
      return;
    }

    async function load(currentEpicId: string) {
      try {
        const rows = await fetchUnifiedSessions<UnifiedSessionRow>(projectId);
        // The route already sorts newest-first, across pages.
        const latest = rows.find(
          (row) => row.kind === "agent_session" && row.epicId === currentEpicId,
        );
        if (!latest || cancelled) return;

        const detailRes = await fetch(
          `/api/projects/${projectId}/sessions/${latest.id}`,
        );
        if (!detailRes.ok) return;
        const detailJson = await detailRes.json();
        const next = (detailJson?.data?.arijActions ?? []) as ArijActionItem[];
        if (!cancelled) setActions(Array.isArray(next) ? next : []);
      } catch {
        // Best-effort ambient detail — the block simply stays hidden.
      }
    }

    setActions([]);
    void load(epicId);

    return () => {
      cancelled = true;
    };
  }, [projectId, epicId, refreshToken]);

  if (actions.length === 0) return null;

  return (
    <div
      className="flex flex-col rounded-[11px] bg-agent-bg px-[16px] py-[14px]"
      data-testid="what-agent-did"
    >
      <span className="mb-[9px] text-[11.5px] uppercase tracking-[.08em] text-agent">
        What the agent did
      </span>
      {actions.map((action, idx) => {
        const Icon = arijActionIcon(action.kind);
        const time = formatArijActionTime(action.at);
        return (
          <div
            key={idx}
            className="flex items-center gap-[9px] py-[5px] text-[13px]"
            data-testid={`what-agent-did-${action.kind}`}
          >
            <Icon
              className={`h-[13px] w-[13px] shrink-0 ${arijActionColor(action.kind)}`}
            />
            <span className="min-w-0 flex-1 truncate">{action.summary}</span>
            {time && (
              <span className="shrink-0 font-mono text-[11px] text-meta">
                {time}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
