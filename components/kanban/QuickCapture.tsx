"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";

interface QuickCaptureProps {
  projectId: string;
  /** Called after the epic is created so the board can refresh */
  onCreated?: () => void;
  onError?: (message: string) => void;
}

/**
 * One-line idea capture for the board's capture bar: type a title, press
 * Enter, and a draft feature epic lands in the backlog — no dialog, no LLM.
 *
 * The field is chromeless on purpose: the 46px bar around it (owned by the
 * board page) is the visible surface, and the placeholder is the only label.
 */
export function QuickCapture({ projectId, onCreated, onError }: QuickCaptureProps) {
  const t = useTranslations("Kanban");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const trimmed = title.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);

    try {
      const res = await fetch(`/api/projects/${projectId}/epics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmed,
          status: "backlog",
          type: "feature",
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        // Keep the typed title so the user can retry without re-typing; the
        // route's own refusal wins over this fallback.
        onError?.(data.error || t("quickCapture.error"));
      } else {
        setTitle("");
        onCreated?.();
      }
    } catch {
      onError?.(t("quickCapture.error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex flex-1 items-center">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
        }}
        placeholder={t("quickCapture.placeholder")}
        disabled={submitting}
        className="h-[30px] w-full border-0 bg-transparent px-0 pr-6 text-[13px] shadow-none placeholder:text-meta focus-visible:border-0 focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/40 disabled:opacity-100 dark:bg-transparent"
        aria-label={t("quickCapture.label")}
        data-testid="quick-capture-input"
      />
      {submitting && (
        <Loader2 className="pointer-events-none absolute right-1 h-3 w-3 animate-spin text-muted-foreground motion-reduce:animate-none" />
      )}
    </div>
  );
}
