"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, FileText, Moon, RotateCcw, Sparkles } from "lucide-react";
import {
  BandHeader,
  Mono,
  PillButton,
  QuietLink,
  StrataBand,
  SurfaceCard,
  type MonoTone,
} from "@/components/piscine";
import { SpecPreview } from "@/components/spec/SpecPreview";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { PROJECT_MEMORY_MAX_CHARS } from "@/lib/documents/memory-constants";
import type {
  MemoryWriteProvenance,
  MemoryWriteSource,
} from "@/lib/documents/memory-provenance";
import {
  DREAMING_MEMORY_SECTIONS,
  MEMORY_WRITER_AGENT_TYPES,
} from "@/lib/workflow/dreaming-constants";

export const DREAMING_MEMORY_TEMPLATE = DREAMING_MEMORY_SECTIONS.map(
  (title) => `## ${title}\n\n- `
).join("\n\n");

export function hasAllDreamingSections(markdown: string): boolean {
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
  /** Applied to the band wrapper — the page uses it for the stacked layout. */
  className?: string;
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
 *
 * FRAME 8b, AND THE GAP IT DRAWS. The frame shows discrete white "entry" cards,
 * one learned fact each, with a per-entry mono provenance and inline
 * `garder` / `jeter` actions. THERE IS NO SUCH STORE: memory is a single
 * markdown document behind app/api/projects/[projectId]/memory/*, with ONE
 * document-level provenance record. Per-entry text, per-entry source session
 * and a kept/discarded flag would all be new columns on a new table.
 *
 * So this band renders the document as ONE editable white card and omits
 * `garder` / `jeter` entirely. Splitting the markdown into pseudo-entries by
 * parsing bullets was considered and rejected: `jeter` would then have to
 * rewrite the whole document by string surgery, and a wrong split silently
 * deletes learned conventions.
 */
export function MemoryPanel({
  projectId: propsProjectId,
  mode,
  className,
}: MemoryPanelProps) {
  const hookParams = useParams();
  const router = useRouter();
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

  const safeContent = content;
  const overCap = safeContent.length > PROJECT_MEMORY_MAX_CHARS;
  const approachingCap =
    !overCap && safeContent.length >= Math.floor(PROJECT_MEMORY_MAX_CHARS * 0.85);
  const dirty = safeContent !== savedContent;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savedContentRef = useRef(savedContent);
  savedContentRef.current = savedContent;
  const pendingWriterRef = useRef(pendingWriter);
  pendingWriterRef.current = pendingWriter;

  const missingSections = DREAMING_MEMORY_SECTIONS.filter((section) =>
    !new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(safeContent)
  );
  const hasMissingSections = missingSections.length > 0;

  const applyEnvelope = useCallback(
    (envelope: MemoryEnvelope, keepLocalEdit: boolean) => {
      const incomingContent = envelope.content ?? "";
      const previousSaved = savedContentRef.current;
      setSavedContent(incomingContent);
      setUpdatedAt(envelope.updatedAt ?? null);
      setProvenance(envelope.provenance ?? null);
      setArchive(envelope.archive ?? null);
      setPendingWriter(envelope.pendingWriter ?? null);
      if (!keepLocalEdit) {
        setContent(incomingContent);
        setBackgroundUpdateConflict(false);
      } else {
        if (incomingContent !== previousSaved) {
          setBackgroundUpdateConflict(true);
        }
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

  const refetchMemory = useCallback(() => {
    if (!projectId) return;
    fetch(`/api/projects/${projectId}/memory`)
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json().catch(() => null)) as { data: MemoryEnvelope } | null;
      })
      .then((data) => {
        if (data?.data) {
          applyEnvelope(data.data, dirtyRef.current);
        }
      })
      .catch(() => {});
  }, [projectId, applyEnvelope]);

  const { pollTick } = useProjectEvents(projectId, {
    "memory:changed": () => refetchMemory(),
    "session:started": (event) => {
      const agentType = typeof event.data?.agentType === "string" ? event.data.agentType : "";
      if (MEMORY_WRITER_AGENT_TYPES.includes(agentType)) {
        refetchMemory();
      }
    },
    "session:completed": (event) => {
      const agentType = typeof event.data?.agentType === "string" ? event.data.agentType : "";
      const sessionId = typeof event.data?.sessionId === "string" ? event.data.sessionId : "";
      if (
        MEMORY_WRITER_AGENT_TYPES.includes(agentType) ||
        (pendingWriterRef.current && pendingWriterRef.current.sessionId === sessionId)
      ) {
        refetchMemory();
      }
    },
    "session:failed": (event) => {
      const agentType = typeof event.data?.agentType === "string" ? event.data.agentType : "";
      const sessionId = typeof event.data?.sessionId === "string" ? event.data.sessionId : "";
      if (
        MEMORY_WRITER_AGENT_TYPES.includes(agentType) ||
        (pendingWriterRef.current && pendingWriterRef.current.sessionId === sessionId)
      ) {
        refetchMemory();
      }
    },
  });
  useEffect(() => {
    if (pollTick > 0) {
      refetchMemory();
    }
  }, [pollTick, refetchMemory]);

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
      router.push(`/projects/${projectId}/sessions/${dreamSessionId}`);
    } catch {
      setError("Failed to start the dreaming session.");
    } finally {
      setDreaming(false);
    }
  }

  function handleInsertSkeleton() {
    if (!safeContent.trim()) {
      setContent(DREAMING_MEMORY_TEMPLATE);
      setMessage("Inserted the 4-sections Dreaming skeleton.");
      return;
    }
    const missing = DREAMING_MEMORY_SECTIONS.filter((section) =>
      !new RegExp(`^##\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").test(safeContent)
    );
    if (missing.length > 0) {
      const toAppend = missing.map((title) => `## ${title}\n\n- `).join("\n\n");
      const separator = safeContent.endsWith("\n\n") ? "" : safeContent.endsWith("\n") ? "\n" : "\n\n";
      setContent(`${safeContent}${separator}${toAppend}`);
      setMessage(`Appended missing Dreaming section(s): ${missing.join(", ")}.`);
    } else {
      setMessage("All 4 required Dreaming sections are already present.");
    }
  }

  // The cap indicator is the one numeral on this band that changes tone, and
  // it changes it for a NUMBER crossing a threshold, not for a UI state.
  // Amber is not a Piscine colour, so "approaching" borrows the sand deep.
  const capTone: MonoTone = overCap
    ? "danger"
    : approachingCap
      ? "you-deep"
      : "live-mid";

  const provenanceStamp = provenance?.at ?? updatedAt;

  return (
    <div
      ref={panelRef}
      id="memory-panel"
      data-testid="memory-card"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <StrataBand
        stratum="live"
        density="rail"
        gap={9}
        grow
        className="px-[16px] py-[14px]"
      >
        {/*
          The band label reads MEMORY; screen readers still get a real
          document heading, which is also what pins the accessible structure
          the existing suite asserts.
        */}
        <h3 className="sr-only">Project memory</h3>

        <BandHeader
          stratum="live"
          label="Memory"
          labelSize={12}
          meta="ce que les agents ont appris"
          right={
            <span data-testid="memory-cap-indicator">
              <Mono size={10.5} tone={capTone}>
                {`${safeContent.length} / ${PROJECT_MEMORY_MAX_CHARS}`}
              </Mono>
            </span>
          }
        />

        {/* An agent is rewriting this document: the editor goes read-only. */}
        {pendingWriter && (
          <div data-testid="memory-pending-writer-banner" className="flex-none">
            <SurfaceCard
              radius={10}
              className="flex flex-wrap items-center gap-[8px] px-[11px] py-[9px]"
            >
              <Sparkles
                size={13}
                aria-hidden="true"
                className="shrink-0 text-strata-live-deep"
              />
              <span className="text-[12px] text-foreground">
                A{" "}
                {pendingWriter.agentType === "memory_distill"
                  ? "distillation"
                  : "Dreaming"}{" "}
                rewrite is currently in progress.
              </span>
              <span className="text-[12px] text-muted-foreground">
                The editor is in read-only mode.
              </span>
              <QuietLink
                tone="live"
                size={11.5}
                className="ml-auto"
                href={`/projects/${projectId}/sessions/${pendingWriter.sessionId}`}
              >
                View session
              </QuietLink>
            </SurfaceCard>
          </div>
        )}

        {/* The document moved under the user's feet while they were editing. */}
        {backgroundUpdateConflict && dirty && (
          <div data-testid="memory-conflict-notice" className="flex-none">
            <SurfaceCard
              radius={10}
              className="flex items-start gap-[8px] px-[11px] py-[9px]"
            >
              <AlertTriangle
                size={13}
                aria-hidden="true"
                className="mt-[2px] shrink-0 text-destructive"
              />
              <span className="text-[12px] text-foreground">
                The memory was updated in the background while you were editing.
                Your unsaved changes are preserved. You can review and save them,
                or click Discard to reload the latest version.
              </span>
            </SurfaceCard>
          </div>
        )}

        {loading ? (
          <p className="text-[12.5px] text-muted-foreground">
            Loading project memory...
          </p>
        ) : !loaded ? (
          <p className="text-[12.5px] text-destructive">
            {error ?? "Failed to load project memory."} Reload the page to try
            again.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-[9px]">
            {/* Empty or non-conforming memory: offer the 4 Dreaming sections. */}
            {mode === "edit" && hasMissingSections && !pendingWriter && (
              <div
                data-testid="memory-skeleton-suggestion"
                className="flex flex-none items-center gap-[8px] rounded-[10px] border-[1.5px] border-dashed border-border-strong px-[11px] py-[9px]"
              >
                <FileText
                  size={13}
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 text-[12px] text-muted-foreground">
                  {!safeContent.trim()
                    ? "No project memory yet. Start with the 4 Dreaming sections:"
                    : `Missing Dreaming section(s): ${missingSections.join(", ")}.`}
                </span>
                <PillButton
                  variant="outline"
                  outlineTone="action"
                  size="sm"
                  className="ml-auto"
                  onClick={handleInsertSkeleton}
                >
                  {!safeContent.trim()
                    ? "Use 4-sections template"
                    : "Append missing sections"}
                </PillButton>
              </div>
            )}

            {mode === "edit" ? (
              <SurfaceCard
                radius={10}
                className="flex min-h-0 flex-1 flex-col overflow-hidden px-[12px] py-[10px]"
              >
                <Textarea
                  data-testid="memory-editor"
                  value={content}
                  onChange={(event) => {
                    setContent(event.target.value);
                    setMessage(null);
                  }}
                  disabled={!!pendingWriter || saving || restoring}
                  placeholder="No project memory yet. Write durable conventions here, or distill them from a completed session."
                  className="h-full min-h-0 flex-1 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 font-mono text-[12.5px] leading-[1.6] shadow-none focus-visible:border-0 focus-visible:ring-0"
                />
              </SurfaceCard>
            ) : (
              <div
                data-testid="memory-preview"
                className="flex min-h-0 flex-1 flex-col"
              >
                <SurfaceCard
                  radius={10}
                  className="min-h-0 flex-1 overflow-y-auto px-[12px] py-[10px]"
                >
                  {safeContent.trim() ? (
                    <SpecPreview markdown={safeContent} />
                  ) : (
                    <p className="text-[12.5px] text-muted-foreground">
                      No project memory yet.
                    </p>
                  )}
                </SurfaceCard>
              </div>
            )}

            {/* Pre-dream snapshot restore, behind an explicit confirmation. */}
            {archive && (
              <div
                data-testid="memory-archive-bar"
                className="flex flex-none flex-wrap items-center gap-[8px] rounded-[10px] border-[1.5px] border-dashed border-border-strong px-[11px] py-[9px]"
              >
                <span className="text-[12px] text-muted-foreground">
                  A pre-dream snapshot exists
                  {archive.updatedAt
                    ? ` (from ${new Date(archive.updatedAt).toLocaleString()})`
                    : ""}
                  .
                </span>
                {confirmingRestore ? (
                  <div className="ml-auto flex items-center gap-[6px]">
                    <span className="text-[11.5px] font-semibold text-foreground">
                      Replace with snapshot?
                    </span>
                    <PillButton
                      variant="filled"
                      size="sm"
                      onClick={handleRestore}
                      disabled={restoring || saving || dirty}
                      pending={restoring}
                      pendingLabel="Restoring..."
                    >
                      Confirm
                    </PillButton>
                    <PillButton
                      variant="outline"
                      outlineTone="neutral"
                      size="sm"
                      onClick={() => setConfirmingRestore(false)}
                      disabled={restoring}
                    >
                      Cancel
                    </PillButton>
                  </div>
                ) : (
                  <PillButton
                    variant="outline"
                    outlineTone="action"
                    size="sm"
                    icon={RotateCcw}
                    className="ml-auto"
                    onClick={() => setConfirmingRestore(true)}
                    disabled={restoring || saving || dirty || !!pendingWriter}
                    title={
                      dirty
                        ? "Save or discard your edits first — restoring replaces the memory with the snapshot"
                        : "Restore the memory to the pre-dream snapshot"
                    }
                  >
                    Restore snapshot
                  </PillButton>
                )}
              </div>
            )}

            <div className="flex flex-none items-center gap-[8px]">
              {/*
                One document-level provenance line replaces the frame's
                per-entry `session #b2 · 2d ago` stamps: memory is a single
                markdown document here, with one write provenance record.
              */}
              <div
                data-testid="memory-provenance-bar"
                className="flex min-w-0 items-center gap-[6px]"
              >
                <Mono size={9.5} tone="live-mid" clamp={1}>
                  {`${sourceLabel(provenance?.source)}${
                    provenanceStamp
                      ? ` · ${new Date(provenanceStamp).toLocaleString()}`
                      : ""
                  }`}
                </Mono>
                {provenance?.sessionId && (
                  <QuietLink
                    tone="live"
                    size={11.5}
                    className="shrink-0"
                    href={`/projects/${projectId}/sessions/${provenance.sessionId}`}
                  >
                    view session
                  </QuietLink>
                )}
              </div>

              <div className="ml-auto flex flex-none items-center gap-[8px]">
                {dirty && (
                  <PillButton
                    variant="outline"
                    outlineTone="neutral"
                    size="sm"
                    onClick={() => {
                      setContent(savedContent);
                      setMessage(null);
                      setBackgroundUpdateConflict(false);
                    }}
                    disabled={saving}
                    title="Restore the saved memory, discarding your edits"
                  >
                    Discard
                  </PillButton>
                )}
                <PillButton
                  variant="outline"
                  outlineTone="action"
                  size="sm"
                  icon={Moon}
                  onClick={handleDream}
                  disabled={dreaming || saving || dirty || !!pendingWriter}
                  pending={dreaming}
                  pendingLabel="Dreaming..."
                  title={
                    dirty
                      ? "Save or discard your edits first — the agent rewrites the SAVED memory"
                      : "Rewrite this memory from the recent sessions of every ticket"
                  }
                >
                  Dream
                </PillButton>
                {/* The one filled button in this row. */}
                <PillButton
                  variant="filled"
                  size="sm"
                  onClick={handleSave}
                  disabled={saving || overCap || !dirty || !!pendingWriter}
                  pending={saving}
                  pendingLabel="Saving..."
                >
                  Save memory
                </PillButton>
              </div>
            </div>
          </div>
        )}

        {approachingCap && (
          <p className="flex-none text-[12px] text-strata-you-deep">
            Approaching the {PROJECT_MEMORY_MAX_CHARS}-character cap (
            {safeContent.length}/{PROJECT_MEMORY_MAX_CHARS}).
          </p>
        )}
        {overCap && (
          <p className="flex-none text-[12px] text-destructive">
            Over the {PROJECT_MEMORY_MAX_CHARS}-character cap (
            {safeContent.length}/{PROJECT_MEMORY_MAX_CHARS}). Trim the content to
            save.
          </p>
        )}
        {message && (
          <p className="flex-none text-[12px] text-strata-live-deep">{message}</p>
        )}
        {error && loaded && (
          <p className="flex-none text-[12px] text-destructive">{error}</p>
        )}
      </StrataBand>
    </div>
  );
}
