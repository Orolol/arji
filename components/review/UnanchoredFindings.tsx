"use client";

import { FileQuestion } from "lucide-react";
import type { FileDiff } from "@/lib/git/diff";
import type { ReviewComment } from "@/hooks/useReviewComments";
import { InlineCommentThread } from "./InlineCommentThread";

/**
 * OPEN review comments whose (filePath, lineNumber) does not match any line
 * of the currently rendered diff. Inline threads only render on matching
 * DiffLine rows, so without this partition agent-submitted findings
 * (submit_findings anchors to arbitrary file+line, including unchanged lines
 * or files outside the diff) would be invisible while still awaiting a fix.
 *
 * Resolved comments are excluded: on a ticket that went through several
 * review cycles the resolved tail grows without bound, and a list of greyed
 * rows under "outside the diff" carries no information the ticket history
 * does not.
 */
export function partitionUnanchoredComments(
  files: FileDiff[],
  comments: ReviewComment[]
): ReviewComment[] {
  const anchored = new Set<string>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        // Mirror DiffLine's anchor rule: newLineNumber ?? oldLineNumber.
        const lineNumber = line.newLineNumber ?? line.oldLineNumber;
        if (lineNumber != null) {
          anchored.add(`${file.filePath}:${lineNumber}`);
        }
      }
    }
  }
  return comments.filter(
    (c) =>
      c.status === "open" && !anchored.has(`${c.filePath}:${c.lineNumber}`)
  );
}

interface UnanchoredFindingsProps {
  comments: ReviewComment[];
  onUpdateComment: (
    id: string,
    updates: { body?: string; status?: string }
  ) => Promise<unknown>;
  onDeleteComment: (id: string) => Promise<unknown>;
}

/**
 * Renders unanchored review comments grouped by file:line, above the file
 * diffs. Renders nothing when every comment has an inline anchor.
 */
export function UnanchoredFindings({
  comments,
  onUpdateComment,
  onDeleteComment,
}: UnanchoredFindingsProps) {
  if (comments.length === 0) return null;

  const groups = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const key = `${comment.filePath}:${comment.lineNumber}`;
    const group = groups.get(key);
    if (group) {
      group.push(comment);
    } else {
      groups.set(key, [comment]);
    }
  }

  return (
    <div
      className="border border-border rounded-lg p-3 space-y-3"
      data-testid="unanchored-findings"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <FileQuestion className="h-4 w-4 text-amber-500" />
        Findings outside the diff
        <span className="text-xs text-muted-foreground font-normal">
          — anchored to lines not shown above; resolved by the reviewer or by
          the merge
        </span>
      </div>
      {Array.from(groups.entries()).map(([key, group]) => (
        <div key={key} className="space-y-1">
          <div className="text-xs font-mono text-muted-foreground">{key}</div>
          <InlineCommentThread
            comments={group}
            onUpdate={onUpdateComment}
            onDelete={onDeleteComment}
          />
        </div>
      ))}
    </div>
  );
}
