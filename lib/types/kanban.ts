export const KANBAN_COLUMNS = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
] as const;

export type KanbanStatus = (typeof KANBAN_COLUMNS)[number];

export const COLUMN_LABELS: Record<KanbanStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};

export const PRIORITY_LABELS: Record<number, string> = {
  0: "Low",
  1: "Medium",
  2: "High",
  3: "Critical",
};

export const PRIORITY_COLORS: Record<number, string> = {
  0: "bg-muted text-muted-foreground",
  1: "bg-priority-blue/10 text-priority-blue",
  2: "bg-priority-yellow/10 text-priority-yellow",
  3: "bg-priority-red/10 text-priority-red",
};

export interface KanbanEpic {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: number;
  status: string;
  position: number;
  branchName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  confidence: number | null;
  evidence: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  createdAt: string;
  updatedAt: string;
  type: string; // 'feature' | 'bug'
  linkedEpicId: string | null;
  images: string | null; // JSON array
  usCount: number;
  usDone: number;
  latestCommentId?: string | null;
  latestCommentAuthor?: string | null;
  latestCommentCreatedAt?: string | null;
}

export type KanbanAgentActionType = "build" | "review" | "merge";

export interface KanbanEpicAgentActivity {
  sessionId: string;
  actionType: KanbanAgentActionType;
  agentName: string;
}

export interface BoardState {
  columns: Record<KanbanStatus, KanbanEpic[]>;
}

export interface ReorderItem {
  id: string;
  status: string;
  position: number;
}

export const USER_STORY_STATUSES = ["todo", "in_progress", "review", "done"] as const;
export type UserStoryStatus = (typeof USER_STORY_STATUSES)[number];

export const USER_STORY_STATUS_LABELS: Record<UserStoryStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
};
