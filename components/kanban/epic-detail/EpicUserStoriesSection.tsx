"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserStoryQuickActions } from "@/components/epic/UserStoryQuickActions";
import { Plus, Trash2, Check, Circle, Loader2 } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { GradingStatusBadge } from "@/components/grading/GradingStatusBadge";
import {
  findCriterionGrading,
  parseAcceptanceCriteria,
  type GradingReportData,
} from "@/lib/grading/report";

interface UserStory {
  id: string;
  title: string;
  status: string;
  acceptanceCriteria: string | null;
}

interface EpicUserStoriesSectionProps {
  projectId: string;
  userStories: UserStory[];
  gradingReport: GradingReportData | null;
  newStoryTitle: string;
  onNewStoryTitleChange: (value: string) => void;
  onAddStory: () => void;
  onUpdateStory: (id: string, updates: { status: string }) => void;
  onDeleteStory: (id: string) => void;
  onRefresh: () => void;
  actionsLocked: boolean;
}

const statusIcon = (status: string) => {
  switch (status) {
    case "done":
      return <Check className="h-3.5 w-3.5 text-agent" />;
    case "in_progress":
      return <Loader2 className="h-3.5 w-3.5 text-priority-yellow" />;
    default:
      return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
  }
};

/**
 * User story checklist for an epic: status toggle, quick agent actions,
 * delete, and the add-story input. State lives in the parent; this is
 * pure presentation.
 *
 * The composer stays hidden behind an "Add a story" accent link until the
 * user asks for it, which is what keeps the empty section down to two lines.
 */
export function EpicUserStoriesSection({
  projectId,
  userStories,
  gradingReport,
  newStoryTitle,
  onNewStoryTitleChange,
  onAddStory,
  onUpdateStory,
  onDeleteStory,
  onRefresh,
  actionsLocked,
}: EpicUserStoriesSectionProps) {
  const [composerOpen, setComposerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function openComposer() {
    setComposerOpen(true);
    // Focus after the input mounts.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <div className="flex flex-col gap-[10px] border-t border-border-soft pt-[16px]">
      <h4 className="text-[12px] uppercase tracking-[.08em] text-meta">
        User Stories ({userStories.length})
      </h4>

      {userStories.length === 0 && (
        <p className="text-[13px] text-muted-foreground">None yet.</p>
      )}

      <TooltipProvider>
        <div className="flex flex-col">
          {userStories.map((us) => {
            const criteria = parseAcceptanceCriteria(us.acceptanceCriteria);
            return (
              <div
                key={us.id}
                className="group rounded-[7px] px-1 py-[7px] hover:bg-band"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Toggle story status"
                    onClick={() => {
                      const next =
                        us.status === "done"
                          ? "todo"
                          : us.status === "todo"
                            ? "in_progress"
                            : "done";
                      onUpdateStory(us.id, { status: next });
                    }}
                  >
                    {statusIcon(us.status)}
                  </button>
                  <Link
                    href={`/projects/${projectId}/stories/${us.id}`}
                    className={cn(
                      "flex-1 text-[13px] hover:underline",
                      us.status === "done" &&
                        "text-muted-foreground line-through",
                    )}
                  >
                    {us.title}
                  </Link>
                  <UserStoryQuickActions
                    projectId={projectId}
                    story={us}
                    onRefresh={onRefresh}
                    isLocked={actionsLocked}
                    lockReason="Another agent is already running for this epic."
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100"
                    onClick={() => onDeleteStory(us.id)}
                    aria-label="Delete story"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>

                {criteria.length > 0 && (
                  <ul className="ml-[22px] mt-2 flex flex-col gap-1.5">
                    {criteria.map((criterion, index) => {
                      const grading = findCriterionGrading(
                        gradingReport?.gradings,
                        us.id,
                        criterion,
                      );
                      return (
                        <li
                          key={`${us.id}-criterion-${index}`}
                          className="flex items-start justify-between gap-3 text-[12px] leading-[1.45] text-muted-foreground"
                        >
                          <span className="min-w-0 flex-1">{criterion}</span>
                          <GradingStatusBadge
                            status={grading?.status ?? null}
                            evidence={grading?.evidence}
                            testId={`criterion-grading-${us.id}-${index}`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </TooltipProvider>

      {composerOpen ? (
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            value={newStoryTitle}
            onChange={(e) => onNewStoryTitleChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onAddStory()}
            placeholder="Add user story..."
            className="h-[29px] rounded-[7px] text-[13px]"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={onAddStory}
            disabled={!newStoryTitle.trim()}
            className="h-[29px] rounded-[7px]"
            aria-label="Add story"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openComposer}
          className="inline-flex w-fit items-center gap-[6px] text-[13px] text-primary hover:underline"
        >
          <Plus className="h-[13px] w-[13px]" />
          Add a story
        </button>
      )}
    </div>
  );
}
