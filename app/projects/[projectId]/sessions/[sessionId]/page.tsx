"use client";

import { useCallback, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { usePolling } from "@/hooks/usePolling";
import { PROVIDER_LABELS } from "@/lib/agent-config/constants";
import { fetchSessionArijActions } from "@/lib/agent-sessions/session-detail";
import type { ArijActionItem } from "@/components/shared/ArijActionsList";
import { LiveSessionScreen } from "@/components/session-live/LiveSessionScreen";
import { deriveTypeLabel } from "@/components/session-live/SessionHeaderBar";
import type { SessionDetail } from "@/components/session-live/types";

/**
 * Frame 8a — the live session.
 *
 * All of the page's BEHAVIOUR lives here, so the whole behavioural diff is
 * reviewable in one file; `<LiveSessionScreen>` owns the layout. Three things
 * in here look like ordinary code and are not — each closed a measured stall
 * or a shipped bug, and each is commented where it sits:
 *
 * 1. The Arij-actions scan is its OWN request (`loadSession`, below).
 * 2. The prompt is LAZY (`loadPrompt`, below).
 * 3. `usePolling(loadSession, 3000)` is unconditional, including for finished
 *    sessions.
 */
export default function SessionDetailPage() {
  const t = useTranslations("SessionLive");
  // Namespace-less, for the KEY REFERENCES `session-live/labels.ts` holds.
  const tKey = useTranslations();
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const sessionId = params.sessionId as string;
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [distilling, setDistilling] = useState(false);
  const [distillError, setDistillError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [promptState, setPromptState] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  /**
   * Arij actions, once the raw-stream scan has run. Null until then, so the
   * list falls back to the durable half the detail payload already carries.
   */
  const [arijActions, setArijActions] = useState<ArijActionItem[] | null>(null);

  const loadSession = useCallback(async () => {
    const res = await fetch(
      `/api/projects/${projectId}/sessions/${sessionId}`
    );
    const data = await res.json();
    setSession(data.data);
    setLoading(false);

    // The chunk-derived half of the actions list is its own request: finding
    // it means scanning the raw stream, which is 113 MB for the worst session
    // on the live database and would stall the shared connection on every
    // 3-second poll if it rode along with the payload above. The scan resumes
    // where it left off server-side, so after the first pass a poll only
    // covers what the session appended since.
    const actions = await fetchSessionArijActions(projectId, sessionId, {
      onPage: (page) => setArijActions(page.actions),
    });
    if (actions) setArijActions(actions);
  }, [projectId, sessionId]);

  /**
   * The prompt is up to 1.8 MB on the live database and is only ever looked
   * at in the prompt pane, so the route leaves it out unless it is asked for.
   * Fetched once, on the first open of that pane — never on mount, never on
   * the 3s poll.
   */
  const loadPrompt = useCallback(async () => {
    setPromptState((current) => (current === "idle" || current === "error" ? "loading" : current));
    try {
      const res = await fetch(
        `/api/projects/${projectId}/sessions/${sessionId}?include=prompt`
      );
      if (!res.ok) throw new Error(`Prompt request failed (${res.status})`);
      const data = await res.json();
      setPrompt(data.data?.prompt ?? null);
      setPromptState("loaded");
    } catch {
      setPromptState("error");
    }
  }, [projectId, sessionId]);

  function handleTogglePrompt() {
    setPromptOpen((open) => !open);
    if (promptState === "idle") void loadPrompt();
  }

  // Initial load + poll if running
  usePolling(loadSession, 3000);

  async function handleCancel() {
    setStopping(true);
    setStopError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/sessions/${sessionId}`,
        { method: "DELETE" }
      );
      // The route answers 409 on a session-lifecycle conflict and 404 when
      // neither the row nor an ephemeral activity-registry entry matches.
      // Surface it rather than silently reloading into the same state.
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStopError(data.error || "Could not stop this session.");
      }
    } catch {
      setStopError("Could not stop this session.");
    } finally {
      setStopping(false);
    }
    loadSession();
  }

  async function handleDistill() {
    setDistilling(true);
    setDistillError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/memory/distill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSessionId: sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDistillError(data.error || "Failed to start memory distillation.");
        return;
      }
      const distillSessionId = data.data?.sessionId;
      if (distillSessionId) {
        router.push(`/projects/${projectId}/sessions/${distillSessionId}`);
      }
    } catch {
      setDistillError("Failed to start memory distillation.");
    } finally {
      setDistilling(false);
    }
  }

  function handleExportLogs() {
    if (!session?.logs) return;
    const blob = new Blob([JSON.stringify(session.logs, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${sessionId}-logs.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading || !session) {
    return (
      <div className="p-6 text-muted-foreground">{t("page.loading")}</div>
    );
  }

  const isRunning = session.status === "running";
  const providerLabel =
    session.namedAgentName ||
    (session.provider
      ? (PROVIDER_LABELS[session.provider as keyof typeof PROVIDER_LABELS] ??
        session.provider)
      : t("page.agentFallback"));
  const { labelKey: typeLabelKey, fallback: typeFallback } =
    deriveTypeLabel(session);
  const typeLabel = typeLabelKey ? tKey(typeLabelKey) : typeFallback;

  return (
    <LiveSessionScreen
      projectId={projectId}
      sessionId={sessionId}
      session={session}
      isRunning={isRunning}
      providerLabel={providerLabel}
      typeLabel={typeLabel}
      arijActions={arijActions}
      onStop={handleCancel}
      stopping={stopping}
      stopError={stopError}
      onRefresh={loadSession}
      onExportLogs={handleExportLogs}
      onDistill={handleDistill}
      distilling={distilling}
      distillError={distillError}
      promptOpen={promptOpen}
      onTogglePrompt={handleTogglePrompt}
      prompt={prompt}
      promptState={promptState}
      onRetryPrompt={loadPrompt}
    />
  );
}
