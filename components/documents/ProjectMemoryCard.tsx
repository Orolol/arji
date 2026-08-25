"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Bot, Moon } from "lucide-react";
import { PROJECT_MEMORY_MAX_CHARS } from "@/lib/documents/memory-constants";

interface ProjectMemoryCardProps {
  projectId: string;
}

/**
 * Docs-tab editor for the learned project memory (documents row with
 * kind 'memory'). The content is injected into every agent prompt for the
 * project, so the card is deliberately explicit about that and about the
 * hard character cap.
 */
export function ProjectMemoryCard({ projectId }: ProjectMemoryCardProps) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Distinct from `!loading`: a finished load that FAILED must not present an
  // editable, saveable textarea over content nobody ever read.
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dreaming, setDreaming] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(null);
    fetch(`/api/projects/${projectId}/memory`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        // Without this check a 404/500 renders as an empty editor, which reads
        // as "this project has no memory" — and saving from there would wipe a
        // memory that merely failed to load.
        if (!res.ok) {
          throw new Error(data?.error || "Failed to load project memory.");
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setContent(data.data?.content ?? "");
        setUpdatedAt(data.data?.updatedAt ?? null);
        setDirty(false);
        setLoaded(true);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err?.message || "Failed to load project memory.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const overCap = content.length > PROJECT_MEMORY_MAX_CHARS;

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to save project memory.");
        return;
      }
      setUpdatedAt(data.data?.updatedAt ?? null);
      setDirty(false);
      setMessage("Project memory saved.");
    } catch {
      setError("Failed to save project memory.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Manual dream. A no-op answer (nothing new since the last dream) is a
   * successful, informative outcome — reported inline, not as an error, and
   * without navigating anywhere since no session was created.
   */
  async function handleDream() {
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

  return (
    <div className="flex flex-col gap-[12px] rounded-[12px] border border-agent-border bg-agent-bg p-[18px]">
      <div className="flex items-center gap-[9px]">
        <Bot className="h-4 w-4 flex-none text-agent" />
        <h3 className="text-[14px] font-semibold">Project memory</h3>
        <span
          className={`ml-auto font-mono text-[11px] ${
            overCap ? "text-destructive" : "text-meta"
          }`}
        >
          {content.length} / {PROJECT_MEMORY_MAX_CHARS}
        </span>
      </div>
      <p className="text-[13.5px] leading-[1.6]">
        Conventions learned from previous sessions. Injected into every agent
        prompt for this project. Use the &quot;Distill learnings&quot; action on
        a completed session to fold in one run, or &quot;Dream&quot; below to
        rewrite it from the recent sessions of every ticket at once.
      </p>
      {loading ? (
        <p className="text-[13px] text-muted-foreground">Loading...</p>
      ) : !loaded ? (
        // Load failed: show the error and nothing editable. An empty textarea
        // here would read as "this project has no memory", and one Save would
        // replace a memory that simply never arrived.
        <p className="text-[13px] text-destructive">
          {error ?? "Failed to load project memory."} Reload the page to try
          again.
        </p>
      ) : (
        <>
          <Textarea
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setDirty(true);
              setMessage(null);
            }}
            placeholder="No project memory yet. Write durable conventions here, or distill them from a completed session."
            className="min-h-[160px] rounded-[10px] border-agent-border bg-card font-mono text-[12px] leading-[1.6]"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-agent">
              {updatedAt
                ? `last updated ${new Date(updatedAt).toLocaleString()}`
                : "never updated"}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-[29px] rounded-[8px] text-[12.5px]"
                onClick={handleDream}
                disabled={dreaming || saving || dirty}
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
                disabled={saving || overCap || !dirty}
              >
                {saving ? "Saving..." : "Save memory"}
              </Button>
            </div>
          </div>
        </>
      )}
      {dirty && loaded && (
        <p className="text-[12px] text-muted-foreground">
          Dreaming reads the saved memory and replaces it wholesale — save or
          discard your edits first, or they will be lost.
        </p>
      )}
      {overCap && (
        <p className="text-[12px] text-destructive">
          Over the {PROJECT_MEMORY_MAX_CHARS}-character cap. Trim the content to
          save.
        </p>
      )}
      {message && <p className="text-[12px] text-agent">{message}</p>}
      {/* Only ACTION errors (save, dream) belong here. A load failure already
          owns the whole body above, and printing it twice reads as two faults. */}
      {error && loaded && (
        <p className="text-[12px] text-destructive">{error}</p>
      )}
    </div>
  );
}
