"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Hammer, GitMerge, Loader2, MessageSquare, CheckCheck } from "lucide-react";
import type { ReviewComment } from "@/hooks/useReviewComments";

interface ReviewActionsProps {
  projectId: string;
  epicId: string;
  epicStatus: string;
  openCount: number;
  comments: ReviewComment[];
  onBackToDev: (comment: string) => Promise<unknown>;
  /** Merge the epic's branch — the merge IS the approval (POST .../merge). */
  onMerge: () => Promise<unknown>;
  onResolveAll: () => Promise<unknown>;
  dispatching?: boolean;
  isRunning?: boolean;
}

export function ReviewActions({
  projectId,
  epicId,
  epicStatus,
  openCount,
  comments,
  onBackToDev,
  onMerge,
  onResolveAll,
  dispatching,
  isRunning,
}: ReviewActionsProps) {
  const [backToDevOpen, setBackToDevOpen] = useState(false);
  const [additionalComment, setAdditionalComment] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const [merging, setMerging] = useState(false);
  const [resolvingAll, setResolvingAll] = useState(false);
  const t = useTranslations("Review");

  const actionsLocked = dispatching || isRunning;
  const canBackToDev = ["review", "to_merge", "in_progress", "todo", "backlog"].includes(epicStatus);
  const canMerge = epicStatus === "to_merge";

  async function handleBackToDev() {
    setSendingBack(true);
    try {
      // Build the rework comment from open review comments.
      //
      // NOT COPY, and deliberately absent from the catalogue: this markdown is
      // the prompt an agent reads on the next iteration, and it is persisted on
      // the ticket. Agent-facing and persisted text is pinned to English at its
      // own site rather than following the interface locale
      // (lib/i18n/catalogue.ts, exclusion 5).
      const openComments = comments.filter((c) => c.status === "open");
      const parts: string[] = [];

      if (openComments.length > 0) {
        parts.push("## Review Comments\n");
        // Group by file
        const byFile = new Map<string, ReviewComment[]>();
        for (const c of openComments) {
          const existing = byFile.get(c.filePath) || [];
          existing.push(c);
          byFile.set(c.filePath, existing);
        }
        for (const [filePath, fileComments] of byFile) {
          parts.push(`### ${filePath}`);
          for (const c of fileComments) {
            parts.push(`- **Line ${c.lineNumber}**: ${c.body}`);
          }
          parts.push("");
        }
      }

      if (additionalComment.trim()) {
        parts.push("## Additional Instructions\n");
        parts.push(additionalComment.trim());
      }

      const fullComment = parts.join("\n");
      await onBackToDev(fullComment);
      setBackToDevOpen(false);
      setAdditionalComment("");
    } finally {
      setSendingBack(false);
    }
  }

  async function handleMerge() {
    setMerging(true);
    try {
      // The merge is the approval: the route resolves whatever comments
      // remain open as part of the same action.
      await onMerge();
    } finally {
      setMerging(false);
    }
  }

  async function handleResolveAll() {
    setResolvingAll(true);
    try {
      await onResolveAll();
    } finally {
      setResolvingAll(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 flex-wrap border border-border rounded-lg p-3 bg-muted/30">
        {openCount > 0 && (
          <Badge variant="outline" className="gap-1 text-xs text-blue-500 border-blue-500/30">
            <MessageSquare className="h-3 w-3" />
            {t("actions.open", { count: openCount })}
          </Badge>
        )}

        <div className="flex-1" />

        {openCount > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleResolveAll}
            disabled={resolvingAll}
            className="h-7 text-xs"
          >
            {resolvingAll ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <CheckCheck className="h-3 w-3 mr-1" />
            )}
            {t("actions.resolveAll")}
          </Button>
        )}

        {canBackToDev && openCount > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAdditionalComment("");
              setBackToDevOpen(true);
            }}
            disabled={actionsLocked}
            className="h-7 text-xs"
          >
            <Hammer className="h-3 w-3 mr-1" />
            {t("actions.backToDev")}
          </Button>
        )}

        {canMerge && (
          <Button
            size="sm"
            onClick={handleMerge}
            disabled={merging || actionsLocked}
            className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
          >
            {merging ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <GitMerge className="h-3 w-3 mr-1" />
            )}
            {t("actions.merge")}
          </Button>
        )}
      </div>

      {/* Back to Dev Dialog */}
      <Dialog open={backToDevOpen} onOpenChange={setBackToDevOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("backToDevDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("backToDevDialog.description", { count: openCount })}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-48 overflow-y-auto border rounded-lg p-3 bg-muted/30 text-xs space-y-2">
            {comments
              .filter((c) => c.status === "open")
              .map((c) => (
                <div key={c.id} className="flex gap-2">
                  <span className="text-muted-foreground font-mono shrink-0">
                    {c.filePath}:{c.lineNumber}
                  </span>
                  <span>{c.body}</span>
                </div>
              ))}
          </div>

          <Textarea
            value={additionalComment}
            onChange={(e) => setAdditionalComment(e.target.value)}
            placeholder={t("backToDevDialog.placeholder")}
            rows={3}
            className="text-sm"
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => setBackToDevOpen(false)}>
              {t("backToDevDialog.cancel")}
            </Button>
            <Button
              onClick={handleBackToDev}
              disabled={sendingBack || actionsLocked}
            >
              {sendingBack ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Hammer className="h-4 w-4 mr-1" />
              )}
              {t("backToDevDialog.send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
