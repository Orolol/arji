"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Sparkles } from "lucide-react";
import { SpecEditor } from "@/components/spec/SpecEditor";
import { SpecUpdateProgress } from "@/components/spec/SpecUpdateProgress";
import { SpecPreview } from "@/components/spec/SpecPreview";
import { SpecUpdateDialog } from "@/components/spec/SpecUpdateDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/utils/format-date";

/** Markdown headings, in document order — the reading outline of the spec. */
function outline(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => /^(#{2,4})\s+(.+?)\s*#*$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[2])
    .slice(0, 12);
}

export default function SpecPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const [spec, setSpec] = useState("");
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
  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.spec) setSpec(d.data.spec);
        if (d.data?.updatedAt) setSavedAt(d.data.updatedAt);
      })
      .catch(() => {});
  }, [projectId]);

  async function handleSave() {
    setSaving(true);
    await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec }),
    });
    setSavedAt(new Date().toISOString());
    setSaving(false);
  }

  const refreshSpec = useCallback(() => {
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.spec !== undefined) setSpec(d.data.spec ?? "");
        if (d.data?.updatedAt) setSavedAt(d.data.updatedAt);
      })
      .catch(() => {});
  }, [projectId]);

  // Poll the spec-update session until it reaches a terminal state, then
  // reload the spec (persisted only on a successful run) and surface the
  // outcome next to the trigger button.
  useEffect(() => {
    if (
      !updateSessionId ||
      updateStatus === "done" ||
      updateStatus === "failed"
    ) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Self-rescheduling: a queued/running answer arms the next tick, so the
    // poll keeps going until the session reaches a terminal state.
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/sessions/${updateSessionId}`,
        );
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        const data = json.data ?? {};
        // Live feedback for the Spec view: the streamed agent output plus,
        // once terminal, the final answer or the failure reason.
        const chunks = data.chunkStreams?.output;
        setUpdateStream(
          Array.isArray(chunks) ? chunks.map((c) => c.content).join("") : null,
        );
        const status = data.status as string | undefined;
        if (status === "queued" || status === "running") {
          timer = setTimeout(poll, 2000);
          return;
        }
        setUpdateResponse(data.logs?.result ?? data.lastNonEmptyText ?? null);
        setUpdateError(data.error ?? null);
        if (status === "completed") {
          setUpdateStatus("done");
          refreshSpec();
        } else {
          setUpdateStatus("failed");
        }
      } catch {
        if (!cancelled) setUpdateStatus("failed");
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [updateSessionId, updateStatus, projectId, refreshSpec]);

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

  const sections = useMemo(() => outline(spec), [spec]);

  return (
    <Tabs defaultValue="edit" className="flex h-full min-h-0 flex-col gap-0">
      <div className="flex flex-none items-start gap-[16px] px-[26px] pb-[18px] pt-[24px]">
        <div className="flex flex-col gap-[5px]">
          <h2 className="text-[19px] font-semibold">Specification</h2>
          <p className="text-[13px] text-muted-foreground">
            The contract agents read before every build. Generated from chat,
            edited by hand.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-[9px]">
          {/* Spec-update feedback lives in the SpecUpdateProgress panel
              below the header — status, stream, response and errors. */}
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
            disabled={saving}
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
      <div className="flex min-h-0 flex-1 gap-[26px] px-[26px] pb-[26px]">
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto rounded-[12px] border border-border bg-card px-[44px] py-[34px]">
          <span className="font-mono text-[11.5px] text-meta">
            SPEC.md{savedAt ? ` · saved ${timeAgo(savedAt)}` : ""}
          </span>
          <TabsContent value="edit" className="mt-[16px]">
            <SpecEditor projectId={projectId} value={spec} onChange={setSpec} />
          </TabsContent>
          <TabsContent value="preview" className="mt-[16px]">
            <SpecPreview markdown={spec} />
          </TabsContent>
        </div>

        <aside className="hidden w-[280px] flex-none flex-col gap-[16px] xl:flex">
          <div className="flex flex-col gap-[10px] rounded-[12px] bg-band p-[16px]">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Outline
            </span>
            {sections.length === 0 ? (
              <span className="text-[13px] text-muted-foreground">
                No sections yet.
              </span>
            ) : (
              sections.map((section, index) => (
                <span
                  key={`${section}-${index}`}
                  className="truncate text-[13.5px] text-muted-foreground"
                >
                  {section}
                </span>
              ))
            )}
          </div>
          <div className="flex flex-col gap-[10px] rounded-[12px] border border-border p-[16px]">
            <span className="text-[11.5px] uppercase tracking-[.08em] text-meta">
              Used by
            </span>
            <span className="text-[13.5px] leading-[1.5]">
              Every build, review and QA prompt for this project includes this
              spec.
            </span>
          </div>
        </aside>
      </div>

      <SpecUpdateDialog
        projectId={projectId}
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        onStarted={handleUpdateStarted}
      />
    </Tabs>
  );
}
