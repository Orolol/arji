"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, FileText, FilePlus, FileMinus, FileEdit } from "lucide-react";
import type { FileDiff } from "@/lib/git/diff";
import type { ReviewComment } from "@/hooks/useReviewComments";
import { DiffLine } from "./DiffLine";

interface FileDiffViewProps {
  file: FileDiff;
  comments: ReviewComment[];
  onAddComment: (filePath: string, lineNumber: number, body: string) => Promise<unknown>;
  onUpdateComment: (id: string, updates: { body?: string; status?: string }) => Promise<unknown>;
  onDeleteComment: (id: string) => Promise<unknown>;
  defaultExpanded?: boolean;
}

const statusIcons: Record<string, typeof FileText> = {
  added: FilePlus,
  modified: FileEdit,
  deleted: FileMinus,
  renamed: FileEdit,
};

const statusColors: Record<string, string> = {
  added: "text-green-500",
  modified: "text-blue-500",
  deleted: "text-red-500",
  renamed: "text-yellow-500",
};

export function FileDiffView({
  file,
  comments,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  defaultExpanded = true,
}: FileDiffViewProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const t = useTranslations("Review");
  const fileComments = comments.filter((c) => c.filePath === file.filePath);
  const openComments = fileComments.filter((c) => c.status === "open");
  const StatusIcon = statusIcons[file.status] || FileText;

  const additions = file.hunks.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.type === "add").length,
    0
  );
  const deletions = file.hunks.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.type === "del").length,
    0
  );

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <Button
        variant="ghost"
        className="w-full justify-start h-auto py-2 px-3 rounded-none hover:bg-accent/50"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 mr-2" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 mr-2" />
        )}
        <StatusIcon className={`h-4 w-4 shrink-0 mr-2 ${statusColors[file.status]}`} />
        <span className="text-sm font-mono truncate flex-1 text-left">
          {file.filePath}
        </span>
        {file.oldPath && (
          <span className="text-xs text-muted-foreground mr-2">
            {t("file.renamedFrom", { path: file.oldPath })}
          </span>
        )}
        {openComments.length > 0 && (
          <Badge variant="outline" className="text-[10px] h-5 px-1.5 mr-2 border-blue-500/30 text-blue-500">
            {t("file.comments", { count: openComments.length })}
          </Badge>
        )}
        <span className="text-xs shrink-0">
          {additions > 0 && (
            <span className="text-green-500 mr-1">+{additions}</span>
          )}
          {deletions > 0 && (
            <span className="text-red-500">-{deletions}</span>
          )}
        </span>
      </Button>

      {expanded && (
        <div className="border-t border-border overflow-x-auto">
          {file.hunks.map((hunk, hunkIdx) => (
            <div key={hunkIdx}>
              <div className="bg-accent/30 px-3 py-1 text-xs text-muted-foreground font-mono">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </div>
              {hunk.lines.map((line, lineIdx) => (
                <DiffLine
                  key={`${hunkIdx}-${lineIdx}`}
                  line={line}
                  filePath={file.filePath}
                  comments={comments}
                  onAddComment={(lineNumber, body) =>
                    onAddComment(file.filePath, lineNumber, body)
                  }
                  onUpdateComment={onUpdateComment}
                  onDeleteComment={onDeleteComment}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
