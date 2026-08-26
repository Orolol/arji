"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Sparkles } from "lucide-react";
import { MemoryPanel } from "@/components/spec/MemoryPanel";
import { SpecEditor } from "@/components/spec/SpecEditor";
import { SpecUpdateProgress } from "@/components/spec/SpecUpdateProgress";
import { SpecPreview } from "@/components/spec/SpecPreview";
import { SpecUpdateDialog } from "@/components/spec/SpecUpdateDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/utils/format-date";

interface SessionChunk {
  content: string;
}

interface SessionDetailResponse {
  status?: string;
  chunkStreams?: {
    output?: SessionChunk[];
  };
  logs?: {
    result?: string;
  };
  lastNonEmptyText?: string;
  error?: string;
}

export default function SpecPage({
  pollIntervalMs = 2000,
  params: propsParams,
}: {
  pollIntervalMs?: number;
  params?: Promise<{ projectId: string }>;
} = {}) {
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

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/sessions/${updateSessionId}`
        );
        if (cancelled) return;

        if (res.status === 404) {
          const errData = (await res.json().catch(() => ({}))) as { error?: string };
          setUpdateStatus("failed");
          setUpdateError(errData?.error || "Session not found");
          return;
        }

        if (!res.ok) {
          return;
        }

        const data = (await res.json()) as { data?: SessionDetailResponse };
        const session = data.data;
        if (!session) return;

        const chunks = session.chunkStreams?.output ?? [];
        if (chunks.length > 0) {
          setUpdateStream(chunks.map((c) => c.content).join(""));
        } else if (session.lastNonEmptyText) {
          setUpdateStream(session.lastNonEmptyText);
        }

        if (session.status === "completed") {
          setUpdateStatus("done");
          const finalResult =
            session.logs?.result ||
            (chunks.length > 0
              ? chunks[chunks.length - 1].content
              : session.lastNonEmptyText) ||
            null;
          setUpdateResponse(finalResult);
          refreshSpec();
        } else if (session.status === "failed") {
          setUpdateStatus("failed");
          setUpdateError(session.error || "Agent session failed.");
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
  }, [updateSessionId, updateStatus, projectId, refreshSpec, pollIntervalMs]);

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

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as "edit" | "preview")}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="flex flex-none flex-wrap items-start justify-between gap-[16px] px-[26px] pb-[18px] pt-[24px]">
        <div className="flex flex-col gap-[4px]">
          <h2 className="text-[19px] font-semibold tracking-[-0.01em]">Spec &amp; Memory</h2>
          <p className="text-[13px] text-muted-foreground">
            The project context injected into every build, review, and chat prompt.
          </p>
        </div>
        <div className="flex items-center gap-[9px]">
          <TabsList className="h-[31px] rounded-[8px] bg-band p-[3px]">
            <TabsTrigger
              value="edit"
              className="h-[25px] rounded-[6px] px-[12px] text-[13px]"
            >
              Edit
            </TabsTrigger>
            <TabsTrigger
              value="preview"
              className="h-[25px] rounded-[6px] px-[12px] text-[13px]"
            >
              Preview
            </TabsTrigger>
          </TabsList>
          <Button
            variant="outline"
            onClick={() => setUpdateDialogOpen(true)}
            disabled={updateStatus === "running"}
            className="h-[31px] rounded-[8px] px-[13px] text-[13px]"
            data-testid="spec-update-button"
          >
            <Sparkles className="h-[14px] w-[14px] mr-[6px]" />
            Mettre à jour la spec
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || updateStatus === "running"}
            className="h-[31px] rounded-[8px] px-[13px] text-[13px]"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {updateSessionId && updateStatus && (
        <SpecUpdateProgress
          projectId={projectId}
          sessionId={updateSessionId}
          status={updateStatus}
          stream={updateStream}
          response={updateResponse}
          error={updateError}
          onDismiss={handleUpdateDismissed}
        />
      )}

      {/* 2 equal peer panels side-by-side on desktop, vertically stacked on mobile */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2 gap-[24px] px-[26px] pb-[26px] overflow-y-auto">
        {/* Specification Panel */}
        <div
          data-testid="spec-card"
          className="flex min-w-0 flex-col rounded-[12px] border border-border bg-card p-[24px] md:p-[28px] overflow-y-auto"
        >
          <div className="flex flex-none items-center justify-between gap-2 pb-[14px]">
            <h3 className="text-[15px] font-semibold tracking-[-0.01em]">Specification</h3>
            <span className="font-mono text-[11.5px] text-meta">
              SPEC.md
              {savedAt ? ` · saved ${timeAgo(savedAt)}` : ""}
              {spec !== savedSpec ? " · unsaved" : ""}
            </span>
          </div>
          <p className="flex-none text-[12.5px] leading-[1.55] text-muted-foreground pb-[14px]">
            The durable software specification — architecture, contracts, constraints, and requirements.
          </p>
          <TabsContent value="edit" className="mt-0 flex-1 flex flex-col min-h-[300px]">
            <SpecEditor
              projectId={projectId}
              value={spec}
              onChange={setSpec}
              disabled={updateStatus === "running"}
            />
          </TabsContent>
          <TabsContent value="preview" className="mt-0 flex-1 overflow-y-auto min-h-[300px]">
            <SpecPreview markdown={spec} />
          </TabsContent>
        </div>

        {/* Project Memory Panel */}
        <div
          className="flex min-w-0 flex-col rounded-[12px] border border-border bg-card p-[24px] md:p-[28px] overflow-y-auto"
        >
          <MemoryPanel projectId={projectId} mode={tab} />
        </div>
      </div>

      <SpecUpdateDialog
        projectId={projectId}
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        onStarted={handleUpdateStarted}
        onBeforeStart={handleBeforeUpdateStart}
      />
    </Tabs>
  );
}
