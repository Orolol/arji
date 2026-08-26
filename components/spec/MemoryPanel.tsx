"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertTriangle, FileText, Moon, RotateCcw, Sparkles } from "lucide-react";
import { SpecPreview } from "@/components/spec/SpecPreview";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { PROJECT_MEMORY_MAX_CHARS } from "@/lib/documents/memory-constants";
import type {
  MemoryWriteProvenance,
  MemoryWriteSource,
} from "@/lib/documents/memory-provenance";
import {
  DREAMING_MEMORY_SECTIONS,
} from "@/lib/workflow/dreaming-constants";

export const DREAMING_MEMORY_TEMPLATE = `## Codebase pitfalls

- 

## Recurring agent mistakes

- 

## Strategies that work

- 

## Build instructions

- `;

export function hasAllDreamingSections(markdown: string): boolean {
  if (!markdown || !markdown.trim()) return false;
  return DREAMING_MEMORY_SECTIONS.every((section) =>
    new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(markdown)
  );
}

/**
 * The pending-writer payload of the memory envelope (see
 * lib/workflow/memory-writer-lock): the in-flight memory writer, if any.
 */
interface PendingMemoryWriter {
  sessionId: string;
  agentType: string;
}

/**
 * The GET /api/projects/[projectId]/memory envelope (spec & memory panel,
 * Story 2 of the "gérer la section mémoire" epic).
 */
interface MemoryEnvelope {
  content?: string;
  exists?: boolean;
  updatedAt?: string | null;
  maxChars?: number;
  provenance?: MemoryWriteProvenance | null;
  archive?: {
    content?: string;
    updatedAt?: string | null;
  } | null;
  pendingWriter?: PendingMemoryWriter | null;
}

interface MemoryPanelProps {
  projectId?: string;
  /** Edit or preview mode, shared with the spec editor or switched locally. */
  mode: "edit" | "preview";
}

function sourceLabel(source: MemoryWriteSource | null | undefined): string {
  switch (source) {
    case "manual":
      return "Manual edit";
    case "dreaming":
      return "Dreaming";
    case "distill":
      return "Session distillation";
    default:
      return "Unknown";
  }
}


/**
 * The learned-memory panel of the Spec & Memory section (the "gérer la
 * section mémoire" epic):
 *
 * - pairs as an equal peer next to the spec editor;
 * - edit/preview modes driven by the section's tab;
 * - character cap indicator and approaching warning;
 * - template skeleton for the 4 Dreaming sections when empty/non-conforming;
 * - last write provenance in header (manual / Dreaming / distillation) + timestamp;
 * - 1-click pre-dream snapshot restore with explicit confirmation;
 * - read-only mode and prominent banner while an agent rewrite is in flight;
 * - live sync via SSE on memory:changed events;
 * - `id="memory-panel"`: notification deep links (/projects/[id]/spec#memory-panel)
 *   scroll straight to this panel.
 */
export function MemoryPanel({ projectId: propsProjectId, mode }: MemoryPanelProps) {
  const hookParams = useParams();
  const projectId = propsProjectId || (hookParams?.projectId as string) || "";
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<MemoryWriteProvenance | null>(null);
  const [archive, setArchive] = useState<MemoryEnvelope["archive"]>(null);
  const [pendingWriter, setPendingWriter] = useState<
    MemoryEnvelope["pendingWriter"]
  >(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [dreaming, setDreaming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backgroundUpdateConflict, setBackgroundUpdateConflict] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const safeContent = content ?? "";
  const overCap = safeContent.length > PROJECT_MEMORY_MAX_CHARS;
  const approachingCap =
    !overCap && safeContent.length >= Math.floor(PROJECT_MEMORY_MAX_CHARS * 0.85);
  const dirty = safeContent !== (savedContent ?? "");
  const conformsToDreaming = hasAllDreamingSections(safeContent);

  const applyEnvelope = useCallback(
    (envelope: MemoryEnvelope, keepLocalEdit: boolean) => {
      const incomingContent = envelope.content ?? "";
      setSavedContent(incomingContent);
      setUpdatedAt(envelope.updatedAt ?? null);
      setProvenance(envelope.provenance ?? null);
      setArchive(envelope.archive ?? null);
      setPendingWriter(envelope.pendingWriter ?? null);
      if (!keepLocalEdit) {
        setContent(incomingContent);
        setBackgroundUpdateConflict(false);
      } else {
        setBackgroundUpdateConflict(true);
      }
    },
    []
  );

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(null);
    fetch(`/api/projects/${projectId}/memory`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.error || "Failed to load project memory.");
        }
        return data as { data: MemoryEnvelope };
      })
      .then((data) => {
        if (cancelled) return;
        applyEnvelope(data.data ?? {}, false);
        setLoaded(true);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err?.message || "Failed to load project memory.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, applyEnvelope]);

  useProjectEvents(projectId, {
    "memory:changed": () => {
      if (!projectId) return;
      fetch(`/api/projects/${projectId}/memory`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error())))
        .then((data) => {
          if (data?.data) applyEnvelope(data.data as MemoryEnvelope, dirty);
        })
        .catch(() => {});
    },
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const scroll = () => {
      if (window.location.hash === "#memory-panel") {
        panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    scroll();
    window.addEventListener("hashchange", scroll);
    return () => window.removeEventListener("hashchange", scroll);
  }, []);

  async function handleSave() {
    if (!projectId) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: safeContent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to save project memory.");
        return;
      }
      applyEnvelope(data.data as MemoryEnvelope, false);
      setMessage("Project memory saved.");
    } catch {
      setError("Failed to save project memory.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRestore() {
    if (!projectId) return;
    setRestoring(true);
    setMessage(null);
    setError(null);
    setConfirmingRestore(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/memory/restore`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to restore the memory snapshot.");
        return;
      }
      applyEnvelope(data.data as MemoryEnvelope, false);
      setMessage("Restored the memory to the pre-dream snapshot.");
    } catch {
      setError("Failed to restore the memory snapshot.");
    } finally {
      setRestoring(false);
    }
  }

  async function handleDream() {
    if (!projectId) return;
    setDreaming(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/memory/dream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to start the dreaming session.");
        return;
      }
      const dreamSessionId = data.data?.sessionId;
      if (!dreamSessionId) {
        setMessage(
          data.data?.reason
            ? `Nothing to dream about: ${data.data.reason}.`
            : "Nothing to dream about yet."
        );
        return;
      }
      window.location.href = `/projects/${projectId}/sessions/${dreamSessionId}`;
    } catch {
      setError("Failed to start the dreaming session.");
    } finally {
      setDreaming(false);
    }
  }

  function handleInsertSkeleton() {
    if (safeContent.trim() && !confirm("Replace current memory content with the 4-sections Dreaming template?")) {
      return;
    }
    setContent(DREAMING_MEMORY_TEMPLATE);
    setMessage("Inserted the 4-sections Dreaming skeleton.");
  }

  return (
    <div
      ref={panelRef}
      id="memory-panel"
      data-testid="memory-card"
      className="flex h-full min-h-0 flex-1 flex-col gap-[14px]"
    >
      {/* Header with Title and Cap Indicator */}
      <div className="flex flex-none items-center justify-between gap-[9px]">
        <div className="flex items-center gap-[8px]">
          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">Project memory</h3>
        </div>
        <span
          data-testid="memory-cap-indicator"
          className={`font-mono text-[11.5px] ${
            overCap
              ? "font-semibold text-destructive"
              : approachingCap
                ? "font-medium text-amber-500"
                : "text-meta"
          }`}
        >
          {safeContent.length} / {PROJECT_MEMORY_MAX_CHARS}
        </span>
      </div>

      <p className="flex-none text-[12.5px] leading-[1.55] text-muted-foreground">
        What agents learn about this project — injected into every build, review, and chat prompt.
      </p>

      {/* Story 3: Last write provenance */}
      <div
        data-testid="memory-provenance-bar"
        className="flex flex-none flex-wrap items-center gap-[8px] rounded-[8px] bg-band px-[12px] py-[8px] text-[12px] text-muted-foreground"
      >
        <span className="font-medium uppercase tracking-[.06em] text-meta">Last write:</span>
        <span className="font-medium text-foreground">{sourceLabel(provenance?.source)}</span>
        {provenance?.at && (
          <span className="font-mono text-[11px] text-meta">
            · {new Date(provenance.at).toLocaleString()}
          </span>
        )}
        {provenance?.sessionId && (
          <Link
            className="ml-auto text-primary underline underline-offset-2 hover:opacity-80"
            href={`/projects/${projectId}/sessions/${provenance.sessionId}`}
          >
            view session
          </Link>
        )}
      </div>

      {/* Story 4: Active Writer Banner (Read-only mode) */}
      {pendingWriter && (
        <div
          data-testid="memory-pending-writer-banner"
          className="flex flex-none flex-wrap items-center gap-[8px] rounded-[8px] border border-primary/30 bg-primary/5 px-[12px] py-[9px] text-[12.5px]"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <span className="font-medium text-foreground">
            A {pendingWriter.agentType === "memory_distill" ? "distillation" : "Dreaming"} rewrite is currently in progress.
          </span>
          <span className="text-muted-foreground">The editor is in read-only mode.</span>
          <Link
            className="ml-auto font-medium text-primary underline underline-offset-2 hover:opacity-80"
            href={`/projects/${projectId}/sessions/${pendingWriter.sessionId}`}
          >
            View session
          </Link>
        </div>
      )}

      {/* Background update notice when user was editing */}
      {backgroundUpdateConflict && dirty && (
        <div
          data-testid="memory-conflict-notice"
          className="flex flex-none items-start gap-[8px] rounded-[8px] border border-amber-500/30 bg-amber-500/10 px-[12px] py-[8px] text-[12px] text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-[1px]" />
          <div>
            The memory was updated in the background while you were editing. Your unsaved changes are preserved. You can review and save them, or click Discard to reload the latest version.
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {loading ? (
        <p className="text-[13px] text-muted-foreground">Loading project memory...</p>
      ) : !loaded ? (
        <p className="text-[13px] text-destructive">
          {error ?? "Failed to load project memory."} Reload the page to try again.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-[10px]">
          {/* Skeleton suggestion banner when empty or non-conforming in edit mode */}
          {mode === "edit" && !conformsToDreaming && !pendingWriter && (
            <div
              data-testid="memory-skeleton-suggestion"
              className="flex flex-none items-center justify-between gap-[8px] rounded-[8px] border border-dashed border-border bg-band/50 px-[12px] py-[8px] text-[12px] text-muted-foreground"
            >
              <div className="flex items-center gap-[6px]">
                <FileText className="h-3.5 w-3.5 text-meta" />
                <span>
                  {!safeContent.trim()
                    ? "No project memory yet. Start with the 4 Dreaming sections:"
                    : "Document is missing one or more Dreaming sections."}
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-[24px] rounded-[6px] px-[9px] text-[11.5px]"
                onClick={handleInsertSkeleton}
              >
                Use 4-sections template
              </Button>
            </div>
          )}

          {mode === "edit" ? (
            <Textarea
              data-testid="memory-editor"
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setMessage(null);
              }}
              disabled={!!pendingWriter || saving || restoring}
              placeholder="No project memory yet. Write durable conventions here, or distill them from a completed session."
              className="min-h-[220px] flex-1 resize-y rounded-[10px] border border-border bg-card font-mono text-[12.5px] leading-[1.6] focus-visible:ring-1"
            />
          ) : (
            <div data-testid="memory-preview" className="min-h-[220px] flex-1 overflow-y-auto rounded-[10px] border border-border bg-card p-[16px]">
              {safeContent.trim() ? (
                <SpecPreview markdown={safeContent} />
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  No project memory yet.
                </p>
              )}
            </div>
          )}

          {/* Story 3: Pre-dream snapshot restore bar with confirmation */}
          {archive && (
            <div
              data-testid="memory-archive-bar"
              className="flex flex-none flex-wrap items-center justify-between gap-[8px] rounded-[8px] border border-dashed border-border bg-band/30 px-[12px] py-[8px] text-[12px] text-muted-foreground"
            >
              <span>
                A pre-dream snapshot exists
                {archive.updatedAt ? ` (from ${new Date(archive.updatedAt).toLocaleString()})` : ""}.
              </span>
              {confirmingRestore ? (
                <div className="flex items-center gap-[6px]">
                  <span className="text-[11.5px] font-medium text-foreground">Replace with snapshot?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-[25px] rounded-[6px] px-[8px] text-[11.5px]"
                    onClick={handleRestore}
                    disabled={restoring || saving}
                  >
                    {restoring ? "Restoring..." : "Confirm"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-[25px] rounded-[6px] px-[8px] text-[11.5px]"
                    onClick={() => setConfirmingRestore(false)}
                    disabled={restoring}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-[25px] rounded-[6px] px-[9px] text-[11.5px]"
                  onClick={() => setConfirmingRestore(true)}
                  disabled={restoring || saving || !!pendingWriter}
                >
                  <RotateCcw className="mr-1 h-3 w-3" />
                  Restore snapshot
                </Button>
              )}
            </div>
          )}

          {/* Bottom Controls */}
          <div className="flex flex-none flex-wrap items-center justify-between gap-2 pt-[2px]">
            <span className="min-w-0 truncate font-mono text-[11px] text-meta">
              {updatedAt
                ? `last updated ${new Date(updatedAt).toLocaleString()}`
                : "never updated"}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {dirty && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-[29px] rounded-[8px] text-[12.5px]"
                  onClick={() => {
                    setContent(savedContent);
                    setMessage(null);
                    setBackgroundUpdateConflict(false);
                  }}
                  disabled={saving}
                  title="Restore the saved memory, discarding your edits"
                >
                  Discard
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-[29px] rounded-[8px] text-[12.5px]"
                onClick={handleDream}
                disabled={dreaming || saving || dirty || !!pendingWriter}
                title={
                  dirty
                    ? "Save or discard your edits first — the agent rewrites the SAVED memory"
                    : "Rewrite this memory from the recent sessions of every ticket"
                }
              >
                <Moon className="mr-1 h-3.5 w-3.5" />
                {dreaming ? "Dreaming..." : "Dream"}
              </Button>
              <Button
                size="sm"
                className="h-[29px] rounded-[8px] text-[12.5px]"
                onClick={handleSave}
                disabled={saving || overCap || !dirty || !!pendingWriter}
              >
                {saving ? "Saving..." : "Save memory"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Warnings and Status Messages */}
      {approachingCap && (
        <p className="text-[12px] font-medium text-amber-600 dark:text-amber-400">
          Approaching the {PROJECT_MEMORY_MAX_CHARS}-character cap ({safeContent.length}/{PROJECT_MEMORY_MAX_CHARS}).
        </p>
      )}
      {overCap && (
        <p className="text-[12px] font-medium text-destructive">
          Over the {PROJECT_MEMORY_MAX_CHARS}-character cap ({safeContent.length}/{PROJECT_MEMORY_MAX_CHARS}). Trim the content to save.
        </p>
      )}
      {message && <p className="text-[12px] text-primary">{message}</p>}
      {error && loaded && (
        <p className="text-[12px] text-destructive">{error}</p>
      )}
    </div>
  );
}
