"use client";

import { useTranslations } from "next-intl";

import { useDiff } from "@/hooks/useDiff";
import { useReviewComments } from "@/hooks/useReviewComments";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, FileCode, MessageSquare, GitBranch, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileDiffView } from "./FileDiffView";
import { ReviewActions } from "./ReviewActions";
import {
  UnanchoredFindings,
  partitionUnanchoredComments,
} from "./UnanchoredFindings";

interface DiffViewerProps {
  projectId: string;
  epicId: string;
  epicStatus: string;
  onBackToDev: (comment: string) => Promise<unknown>;
  /** Merge the epic's branch — the merge IS the approval. */
  onMerge: () => Promise<unknown>;
  dispatching?: boolean;
  isRunning?: boolean;
}

export function DiffViewer({
  projectId,
  epicId,
  epicStatus,
  onBackToDev,
  onMerge,
  dispatching,
  isRunning,
}: DiffViewerProps) {
  const { files, metadata, loading: diffLoading, error: diffError, refresh: refreshDiff } = useDiff(projectId, epicId);
  const {
    comments,
    loading: commentsLoading,
    openCount,
    addComment,
    updateComment,
    deleteComment,
    resolveAll,
    refresh: refreshComments,
  } = useReviewComments(projectId, epicId);
  const t = useTranslations("Review");

  // Open review comments (typically agent-submitted findings) whose file:line
  // has no matching line in the rendered diff — they must stay visible so the
  // reviewer's unresolved feedback is never silently hidden.
  const unanchoredComments = partitionUnanchoredComments(files, comments);

  const totalAdditions = files.reduce(
    (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === "add").length, 0),
    0
  );
  const totalDeletions = files.reduce(
    (sum, f) => sum + f.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === "del").length, 0),
    0
  );

  function handleRefresh() {
    refreshDiff();
    refreshComments();
  }

  if (diffLoading && files.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mr-2" />
        <span className="text-sm text-muted-foreground">{t("diff.loading")}</span>
      </div>
    );
  }

  if (diffError) {
    return (
      <div className="py-8 text-center space-y-2">
        <p className="text-sm text-destructive">{diffError}</p>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-3 w-3 mr-1" />
          {t("diff.retry")}
        </Button>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="py-8 text-center space-y-3">
        <FileCode className="h-8 w-8 mx-auto text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t("emptyDiff.title")}</p>

        {/* Diagnostics when diff is empty */}
        {metadata && (
          <div className="max-w-md mx-auto space-y-2">
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <GitBranch className="h-3 w-3" />
              <span className="font-mono">{metadata.branchName}</span>
              <span>{t("emptyDiff.versus")}</span>
              <span className="font-mono">{metadata.baseBranch}</span>
            </div>

            {metadata.ahead > 0 && (
              <p className="text-xs text-amber-500 flex items-center justify-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {metadata.behind > 0
                  ? t("emptyDiff.aheadAndBehind", {
                      count: metadata.ahead,
                      base: metadata.baseBranch,
                      behind: metadata.behind,
                    })
                  : t("emptyDiff.ahead", {
                      count: metadata.ahead,
                      base: metadata.baseBranch,
                    })}
              </p>
            )}

            {metadata.ahead === 0 && !metadata.hasUncommittedChanges && (
              <p className="text-xs text-muted-foreground">
                {t("emptyDiff.notDiverged", { base: metadata.baseBranch })}
              </p>
            )}

            {metadata.hasUncommittedChanges && (
              <p className="text-xs text-amber-500 flex items-center justify-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                {t("emptyDiff.uncommitted")}
              </p>
            )}
          </div>
        )}

        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-3 w-3 mr-1" />
          {t("diff.refresh")}
        </Button>

        {/* Even without a diff, open findings block approval — keep them visible. */}
        {unanchoredComments.length > 0 && (
          <div className="max-w-2xl mx-auto text-left">
            <UnanchoredFindings
              comments={unanchoredComments}
              onUpdateComment={updateComment}
              onDeleteComment={deleteComment}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <Badge variant="outline" className="gap-1 text-xs">
          <FileCode className="h-3 w-3" />
          {t("summary.files", { count: files.length })}
        </Badge>
        <Badge variant="outline" className="gap-1 text-xs text-green-500">
          +{totalAdditions}
        </Badge>
        <Badge variant="outline" className="gap-1 text-xs text-red-500">
          -{totalDeletions}
        </Badge>
        {openCount > 0 && (
          <Badge variant="outline" className="gap-1 text-xs text-blue-500 border-blue-500/30">
            <MessageSquare className="h-3 w-3" />
            {t("summary.openComments", { count: openCount })}
          </Badge>
        )}
        {metadata && metadata.ahead > 0 && (
          <Badge variant="outline" className="gap-1 text-xs text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            {t("summary.commitsAhead", { count: metadata.ahead })}
          </Badge>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-7 text-xs">
          <RefreshCw className={`h-3 w-3 mr-1 ${diffLoading ? "animate-spin" : ""}`} />
          {t("diff.refresh")}
        </Button>
      </div>

      {/* Review actions */}
      <ReviewActions
        projectId={projectId}
        epicId={epicId}
        epicStatus={epicStatus}
        openCount={openCount}
        comments={comments}
        onBackToDev={onBackToDev}
        onMerge={onMerge}
        onResolveAll={resolveAll}
        dispatching={dispatching}
        isRunning={isRunning}
      />

      {/* Findings anchored outside the visible diff */}
      <UnanchoredFindings
        comments={unanchoredComments}
        onUpdateComment={updateComment}
        onDeleteComment={deleteComment}
      />

      {/* File diffs */}
      <ScrollArea className="max-h-[calc(100vh-300px)]">
        <div className="space-y-3 pb-4">
          {files.map((file) => (
            <FileDiffView
              key={file.filePath}
              file={file}
              comments={comments}
              onAddComment={addComment}
              onUpdateComment={updateComment}
              onDeleteComment={deleteComment}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
