"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InlineEdit } from "./InlineEdit";
import { useEpicDetail } from "@/hooks/useEpicDetail";
import { useEpicComments } from "@/hooks/useEpicComments";
import { useEpicAgent } from "@/hooks/useEpicAgent";
import { EpicActions } from "@/components/epic/EpicActions";
import { UserStoryQuickActions } from "@/components/epic/UserStoryQuickActions";
import { CommentThread } from "@/components/story/CommentThread";
import { PRIORITY_LABELS, KANBAN_COLUMNS, COLUMN_LABELS } from "@/lib/types/kanban";
import { Plus, Trash2, Check, Circle, Loader2, GitBranch, GitMerge } from "lucide-react";
import { useState } from "react";
import Link from "next/link";

interface EpicDetailProps {
  projectId: string;
  epicId: string | null;
  open: boolean;
  onClose: () => void;
  onMerged?: () => void;
}

export function EpicDetail({ projectId, epicId, open, onClose, onMerged }: EpicDetailProps) {
  const {
    epic,
    userStories,
    loading,
    updateEpic,
    addUserStory,
    updateUserStory,
    deleteUserStory,
    refresh,
  } = useEpicDetail(projectId, epicId);

  const {
    comments,
    loading: commentsLoading,
    addComment,
  } = useEpicComments(projectId, epicId);

  const {
    activeSessions,
    dispatching,
    isRunning,
    sendToDev,
    sendToReview,
    approve,
  } = useEpicAgent(projectId, epicId);

  const [newUSTitle, setNewUSTitle] = useState("");
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  async function handleMerge() {
    if (!epicId) return;
    setMerging(true);
    setMergeError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/epics/${epicId}/merge`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.error) {
        setMergeError(data.error);
      } else {
        onMerged?.();
        onClose();
      }
    } catch {
      setMergeError("Failed to merge");
    }
    setMerging(false);
  }

  async function handleApprove() {
    await approve();
    refresh();
  }

  async function handleSendToDev(comment?: string) {
    await sendToDev(comment);
    refresh();
  }

  async function handleSendToReview(types: string[]) {
    await sendToReview(types);
    refresh();
  }

  function handleAddUS() {
    if (!newUSTitle.trim()) return;
    addUserStory(newUSTitle.trim());
    setNewUSTitle("");
  }

  const statusIcon = (status: string) => {
    switch (status) {
      case "done":
        return <Check className="h-3.5 w-3.5 text-green-500" />;
      case "in_progress":
        return <Loader2 className="h-3.5 w-3.5 text-yellow-500" />;
      default:
        return <Circle className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[520px] sm:max-w-[520px] overflow-y-auto">
        {loading || !epic ? (
          <div className="py-8 text-center text-muted-foreground">
            Loading...
          </div>
        ) : (
          <>
            <SheetHeader>
              <SheetTitle>
                <InlineEdit
                  value={epic.title}
                  onSave={(v) => updateEpic({ title: v })}
                  className="text-lg font-bold"
                />
              </SheetTitle>
            </SheetHeader>

            <div className="px-4 pb-4 space-y-4">
              {/* Epic Actions Bar */}
              <EpicActions
                epic={epic}
                dispatching={dispatching}
                isRunning={isRunning}
                activeSessions={activeSessions}
                onSendToDev={handleSendToDev}
                onSendToReview={handleSendToReview}
                onApprove={handleApprove}
              />

              <div>
                <label className="text-xs text-muted-foreground block mb-1">
                  Description
                </label>
                <InlineEdit
                  value={epic.description || ""}
                  onSave={(v) => updateEpic({ description: v })}
                  multiline
                  markdown
                  className="text-sm"
                />
              </div>

              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground block mb-1">
                    Priority
                  </label>
                  <Select
                    value={String(epic.priority)}
                    onValueChange={(v) => updateEpic({ priority: Number(v) } as never)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
                        <SelectItem key={k} value={k}>
                          {v}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground block mb-1">
                    Status
                  </label>
                  <Select
                    value={epic.status}
                    onValueChange={(v) => updateEpic({ status: v })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {KANBAN_COLUMNS.map((col) => (
                        <SelectItem key={col} value={col}>
                          {COLUMN_LABELS[col]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {epic.branchName && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                    <GitBranch className="h-3 w-3" />
                    {epic.branchName}
                  </div>
                  {(epic.status === "review" || epic.status === "done") && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleMerge}
                      disabled={merging}
                      className="h-7 text-xs"
                    >
                      {merging ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <GitMerge className="h-3 w-3 mr-1" />
                      )}
                      Merge into main
                    </Button>
                  )}
                  {mergeError && (
                    <p className="text-xs text-destructive">{mergeError}</p>
                  )}
                </div>
              )}

              <Separator />

              {/* User Stories */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-medium">
                    User Stories ({userStories.length})
                  </h4>
                </div>

                <TooltipProvider>
                  <div className="space-y-1">
                    {userStories.map((us) => (
                      <div
                        key={us.id}
                        className="flex items-center gap-2 p-2 rounded hover:bg-accent/50 group"
                      >
                        <button
                          onClick={() => {
                            const next =
                              us.status === "done"
                                ? "todo"
                                : us.status === "todo"
                                  ? "in_progress"
                                  : "done";
                            updateUserStory(us.id, { status: next });
                          }}
                        >
                          {statusIcon(us.status)}
                        </button>
                        <Link
                          href={`/projects/${projectId}/stories/${us.id}`}
                          className={`flex-1 text-sm hover:underline ${
                            us.status === "done"
                              ? "line-through text-muted-foreground"
                              : ""
                          }`}
                        >
                          {us.title}
                        </Link>
                        <UserStoryQuickActions
                          projectId={projectId}
                          story={us}
                          onRefresh={refresh}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 opacity-0 group-hover:opacity-100"
                          onClick={() => deleteUserStory(us.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </TooltipProvider>

                <div className="flex gap-2 mt-2">
                  <Input
                    value={newUSTitle}
                    onChange={(e) => setNewUSTitle(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAddUS()}
                    placeholder="Add user story..."
                    className="text-sm h-8"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAddUS}
                    disabled={!newUSTitle.trim()}
                    className="h-8"
                  >
                    <Plus className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              <Separator />

              {/* Comment Thread */}
              <div className="min-h-[200px]">
                <CommentThread
                  comments={comments}
                  loading={commentsLoading}
                  onAddComment={addComment}
                />
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
