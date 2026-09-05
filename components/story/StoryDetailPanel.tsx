"use client";

import { useId } from "react";
import { Badge } from "@/components/ui/badge";
import { InlineEdit } from "@/components/kanban/InlineEdit";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  USER_STORY_STATUSES,
  USER_STORY_STATUS_LABELS,
  type UserStoryStatus,
} from "@/lib/types/kanban";
import { GitBranch } from "lucide-react";

interface Story {
  id: string;
  epicId: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: string;
  position: number;
  createdAt: string;
  epic: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    branchName: string | null;
    projectId: string;
  } | null;
}

const STATUS_COLORS: Record<string, string> = {
  todo: "bg-muted text-muted-foreground",
  in_progress: "bg-yellow-500/10 text-yellow-500",
  review: "bg-blue-500/10 text-blue-500",
  done: "bg-green-500/10 text-green-500",
};

interface StoryDetailPanelProps {
  story: Story;
  onUpdate: (updates: Partial<Story>) => void;
}

export function StoryDetailPanel({ story, onUpdate }: StoryDetailPanelProps) {
  // Generated rather than static: the panel is a component, and two mounted
  // copies sharing hard-coded ids would point every label at the first one.
  const fieldId = useId();
  const statusId = `${fieldId}-status`;
  const descriptionId = `${fieldId}-description`;
  const descriptionLabelId = `${descriptionId}-label`;
  const criteriaId = `${fieldId}-acceptance-criteria`;
  const criteriaLabelId = `${criteriaId}-label`;

  return (
    <div className="p-6 space-y-6">
      {/* Title */}
      <div>
        <InlineEdit
          value={story.title}
          onSave={(v) => onUpdate({ title: v })}
          className="text-lg font-bold"
        />
      </div>

      {/* Status & Metadata */}
      <div className="flex items-center gap-3">
        <div>
          <label
            htmlFor={statusId}
            className="text-xs text-muted-foreground block mb-1"
          >
            Status
          </label>
          <Select
            value={story.status}
            onValueChange={(v) => onUpdate({ status: v })}
          >
            <SelectTrigger id={statusId} className="h-8 text-xs w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {USER_STORY_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {USER_STORY_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          {/*
            Pure spacer: it lines the badge up with the select beside it and
            names nothing, so it must not be a <label> — an empty label is a
            label pointing at no control.
          */}
          <span
            aria-hidden="true"
            className="text-xs text-muted-foreground block mb-1"
          >
            &nbsp;
          </span>
          <Badge className={STATUS_COLORS[story.status] || STATUS_COLORS.todo}>
            {USER_STORY_STATUS_LABELS[story.status as UserStoryStatus] || story.status}
          </Badge>
        </div>
      </div>

      {/* Epic info */}
      {story.epic && (
        <div className="bg-muted/30 rounded-lg p-3 space-y-1">
          <p className="text-xs text-muted-foreground">Parent Epic</p>
          <p className="text-sm font-medium">{story.epic.title}</p>
          {story.epic.branchName && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
              <GitBranch className="h-3 w-3" />
              {story.epic.branchName}
            </div>
          )}
        </div>
      )}

      {/* Description */}
      <div>
        <label
          id={descriptionLabelId}
          htmlFor={descriptionId}
          className="text-xs text-muted-foreground block mb-1"
        >
          Description
        </label>
        <InlineEdit
          id={descriptionId}
          aria-labelledby={descriptionLabelId}
          value={story.description || ""}
          onSave={(v) => onUpdate({ description: v })}
          multiline
          className="text-sm"
        />
      </div>

      {/* Acceptance Criteria */}
      <div>
        <label
          id={criteriaLabelId}
          htmlFor={criteriaId}
          className="text-xs text-muted-foreground block mb-1"
        >
          Acceptance Criteria
        </label>
        <InlineEdit
          id={criteriaId}
          aria-labelledby={criteriaLabelId}
          value={story.acceptanceCriteria || ""}
          onSave={(v) => onUpdate({ acceptanceCriteria: v })}
          multiline
          className="text-sm font-mono"
        />
      </div>
    </div>
  );
}
