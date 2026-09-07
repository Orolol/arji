"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Sparkles } from "lucide-react";

import { PillButton } from "@/components/piscine";
import { DocsCard } from "@/components/spec/DocsCard";
import { MemoryPanel } from "@/components/spec/MemoryPanel";
import { PromptAnatomyBand } from "@/components/spec/PromptAnatomyBand";
import { SpecBand } from "@/components/spec/SpecBand";
import { SpecUpdateDialog } from "@/components/spec/SpecUpdateDialog";
import { SuggestionBand } from "@/components/spec/SuggestionBand";
import { fetchSessionStream } from "@/lib/agent-sessions/session-detail";

interface SessionDetailResponse {
  status?: string;
  logs?: {
    result?: string;
  } | null;
  lastNonEmptyText?: string;
  error?: string;
}

/**
 * Spec & Memory — frame 8b.
 *
 * SPEC (linden, 7/10) beside a rail of MEMORY (turquoise, the one growing
 * band), SUGGESTION D'AGENT (pool) and DOCS (white), with ANATOMIE DU PROMPT
 * (sun) across the bottom. The page owns every piece of state and every
 * effect; the bands are presentation.
 *
 * The default-export signature is pinned: three suites construct this page
 * with `params={Promise.resolve({projectId})}` and one drives
 * `pollIntervalMs`.
 */
export default function SpecPage({
  pollIntervalMs = 2000,
  params: propsParams,
}: {
  pollIntervalMs?: number;
  params?: Promise<{ projectId: string }>;
} = {}) {
  const t = useTranslations("Spec");
  const hookParams = useParams();
  const [resolvedProjectId, setResolvedProjectId] = useState<string>(
    (hookParams?.projectId as string) || ""
  );

  useEffect(() => {
    if (hookParams?.projectId) {
      setResolvedProjectId(hookParams.projectId as string);
    } else if (propsParams) {
      propsParams.then((p) => {
        if (p?.projectId) setResolvedProjectId(p.projectId);
      });
    }
  }, [hookParams?.projectId, propsParams]);

  const projectId = (hookParams?.projectId as string) || resolvedProjectId || "";
  const [spec, setSpec] = useState("");
  const [savedSpec, setSavedSpec] = useState("");
  const [specLoaded, setSpecLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateSessionId, setUpdateSessionId] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "running" | "done" | "failed" | null
  >(null);
  const [updateStream, setUpdateStream] = useState<string | null>(null);
  const [updateResponse, setUpdateResponse] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // The shared Edit/Preview tab: one control drives BOTH paired panels
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  useEffect(() => {
    if (!projectId) return;
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.spec !== undefined) {
          setSpec(d.data.spec ?? "");
          setSavedSpec(d.data.spec ?? "");
          setSpecLoaded(true);
        }
        if (d.data?.updatedAt) {
          setSavedAt(d.data.updatedAt);
        }
      })
      .catch(() => {});

    fetch(`/api/projects/${projectId}/spec/update`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.pending && d.data.sessionId) {
          setUpdateSessionId(d.data.sessionId);
          setUpdateStatus("running");
        }
      })
      .catch(() => {});
  }, [projectId]);

  async function handleSave() {
    if (!projectId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }),
      });
      const data = await res.json();
      if (data.data) {
        setSavedSpec(data.data.spec ?? "");
        setSavedAt(data.data.updatedAt ?? new Date().toISOString());
      }
    } catch (err) {
      console.error("Failed to save spec:", err);
    } finally {
      setSaving(false);
    }
  }

  const refreshSpec = useCallback(() => {
    if (!projectId) return;
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.spec !== undefined) {
          setSpec(d.data.spec ?? "");
          setSavedSpec(d.data.spec ?? "");
          setSpecLoaded(true);
        }
        if (d.data?.updatedAt) {
          setSavedAt(d.data.updatedAt);
        }
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    if (!updateSessionId || updateStatus !== "running" || !projectId) return;

    let cancelled = false;
    // The detail payload carries only a short preview of each stream now, and
    // it always starts from the beginning — so the live view keeps its own
    // cursor and appends, instead of re-reading the whole stream every 2s.
    let cursor: number | null = null;
    let streamed = "";
    let lastChunk = "";

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/sessions/${updateSessionId}`
        );
        if (cancelled) return;

        if (res.status === 404) {
          const errData = (await res.json().catch(() => ({}))) as { error?: string };
          setUpdateStatus("failed");
          setUpdateError(errData?.error || t("page.sessionNotFound"));
          return;
        }

        if (!res.ok) {
          return;
        }

        const data = (await res.json()) as { data?: SessionDetailResponse };
        const session = data.data;
        if (!session) return;

        try {
          const page = await fetchSessionStream(
            projectId,
            updateSessionId,
            "output",
            { after: cursor }
          );
          if (cancelled) return;
          cursor = page.nextAfter;
          if (page.chunks.length > 0) {
            streamed += page.chunks.map((c) => c.content).join("");
            lastChunk = page.chunks[page.chunks.length - 1].content;
            setUpdateStream(streamed);
          }
        } catch {
          // Transient stream error — the status poll above still drives the
          // dialog, and the next tick asks from the same cursor.
        }

        if (!streamed && session.lastNonEmptyText) {
          setUpdateStream(session.lastNonEmptyText);
        }

        if (session.status === "completed") {
          setUpdateStatus("done");
          const finalResult =
            session.logs?.result ||
            lastChunk ||
            session.lastNonEmptyText ||
            null;
          setUpdateResponse(finalResult);
          refreshSpec();
        } else if (session.status === "failed") {
          setUpdateStatus("failed");
          setUpdateError(session.error || t("page.sessionFailed"));
        }
      } catch {
        // Transient network error — keep polling
      }
    };

    poll();
    const interval = setInterval(poll, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [updateSessionId, updateStatus, projectId, refreshSpec, pollIntervalMs, t]);

  function handleUpdateStarted(data: { sessionId: string }) {
    setUpdateSessionId(data.sessionId);
    setUpdateStatus("running");
    setUpdateStream(null);
    setUpdateResponse(null);
    setUpdateError(null);
  }

  function handleUpdateDismissed() {
    setUpdateSessionId(null);
    setUpdateStatus(null);
    setUpdateStream(null);
    setUpdateResponse(null);
    setUpdateError(null);
  }

  async function handleBeforeUpdateStart() {
    if (spec !== savedSpec) {
      await handleSave();
    }
  }

  /**
   * Frame 8b drew "Régénérer par chat" in the project's 60px header. That
   * header is gone (frame 13a — the global bar is the only one now), and with
   * it the `#project-header-actions` node `HeaderActionSlot` used to portal
   * into: the slot could never find a host again, so the portal was deleted and
   * the pill renders where the fallback already put it — the right end of the
   * SPEC band's own header row, which IS this screen's second row.
   */
  const regenerateAction = (
    <PillButton
      variant="filled"
      size="md"
      icon={Sparkles}
      data-testid="spec-update-button"
      onClick={() => setUpdateDialogOpen(true)}
      disabled={updateStatus === "running"}
    >
      {t("page.regenerate")}
    </PillButton>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-[12px] px-[14px] pb-[14px] max-[1099px]:h-auto max-[1099px]:overflow-y-auto">
      <div className="flex min-h-0 flex-1 gap-[12px] max-[1099px]:flex-none max-[1099px]:flex-col">
        <SpecBand
          className="min-w-0 flex-[7]"
          projectId={projectId}
          spec={spec}
          onSpecChange={setSpec}
          tab={tab}
          onTabChange={setTab}
          loaded={specLoaded}
          savedSpec={savedSpec}
          savedAt={savedAt}
          saving={saving}
          updateRunning={updateStatus === "running"}
          onSave={handleSave}
          headerAction={regenerateAction}
        />

        <div className="flex min-w-0 flex-[3] flex-col gap-[12px]">
          {/* The one growing band on this screen. */}
          <MemoryPanel
            projectId={projectId}
            mode={tab}
            className="max-[1099px]:min-h-[320px] max-[1099px]:flex-none"
          />
          <SuggestionBand
            projectId={projectId}
            sessionId={updateSessionId}
            status={updateStatus}
            stream={updateStream}
            response={updateResponse}
            error={updateError}
            onDismiss={handleUpdateDismissed}
          />
          <DocsCard projectId={projectId} />
        </div>
      </div>

      {/*
        The 24px gap under the columns row is intentional: this band's own
        margin-top stacks with the wrapper's 12px gap. The anatomy is a
        different register from the three editable regions above it.
      */}
      <PromptAnatomyBand projectId={projectId} className="mt-[12px]" />

      <SpecUpdateDialog
        projectId={projectId}
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        onStarted={handleUpdateStarted}
        onBeforeStart={handleBeforeUpdateStart}
      />
    </div>
  );
}
