"use client";

import { useState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelative } from "@/lib/i18n/format";

interface ResumableSession {
  id: string;
  cliSessionId: string | null;
  provider: string | null;
  namedAgentId: string | null;
  agentType: string | null;
  lastNonEmptyText: string | null;
  completedAt: string | null;
}

const EMPTY_SESSIONS: ResumableSession[] = [];

interface SessionPickerProps {
  projectId: string;
  epicId?: string;
  userStoryId?: string;
  agentType?: string;
  namedAgentId?: string | null;
  provider?: string;
  selectedSessionId: string | undefined;
  onSelect: (sessionId: string | undefined) => void;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

export function SessionPicker({
  projectId,
  epicId,
  userStoryId,
  agentType,
  namedAgentId,
  provider,
  selectedSessionId,
  onSelect,
}: SessionPickerProps) {
  const t = useTranslations("Shared");
  const locale = useLocale();
  // Codex has no resumable-session endpoint, so it has no request at all.
  const requestKey =
    provider === "codex"
      ? null
      : [projectId, epicId, userStoryId, agentType, namedAgentId, provider]
          .map((part) => part ?? "")
          .join("|");

  const [loaded, setLoaded] = useState<{
    key: string;
    sessions: ResumableSession[];
  } | null>(null);

  // Both derived from the request identity, which is what the reset/loading
  // setStates at the top of the effect were really tracking.
  const sessions =
    requestKey !== null && loaded?.key === requestKey ? loaded.sessions : EMPTY_SESSIONS;
  const loading = requestKey !== null && loaded?.key !== requestKey;

  useEffect(() => {
    if (requestKey === null) {
      return;
    }

    let cancelled = false;
    const params = new URLSearchParams();
    if (epicId) params.set("epicId", epicId);
    if (userStoryId) params.set("userStoryId", userStoryId);
    if (agentType) params.set("agentType", agentType);
    if (namedAgentId) params.set("namedAgentId", namedAgentId);
    if (provider) params.set("provider", provider);

    fetch(`/api/projects/${projectId}/sessions/resumable?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setLoaded({ key: requestKey, sessions: data.data || [] });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key: requestKey, sessions: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [
    projectId,
    epicId,
    userStoryId,
    agentType,
    namedAgentId,
    provider,
    requestKey,
  ]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (sessions.some((session) => session.id === selectedSessionId)) {
      return;
    }
    onSelect(undefined);
  }, [selectedSessionId, sessions, onSelect]);

  if (!loading && sessions.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground whitespace-nowrap">
        {t("sessionPicker.resume")}
      </span>
      <Select
        value={selectedSessionId ?? "__fresh__"}
        onValueChange={(v) => onSelect(v === "__fresh__" ? undefined : v)}
      >
        <SelectTrigger className="w-64 h-8 text-xs">
          <SelectValue
            placeholder={
              loading
                ? t("sessionPicker.loading")
                : t("sessionPicker.startFresh")
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__fresh__">
            {t("sessionPicker.startFreshItem")}
          </SelectItem>
          {sessions.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              <span className="truncate">
                {/* The session's own last line is trace, not copy. */}
                {s.lastNonEmptyText
                  ? truncate(s.lastNonEmptyText, 60)
                  : t("sessionPicker.session", { id: s.id.slice(0, 8) })}
              </span>
              {s.completedAt && (
                <span className="ml-1 text-muted-foreground">
                  ({formatRelative(s.completedAt, { locale })})
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
