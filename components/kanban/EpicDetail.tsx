"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { InlineEdit } from "./InlineEdit";
import { useEpicDetail } from "@/hooks/useEpicDetail";
import { PRIORITY_LABELS, KANBAN_COLUMNS, COLUMN_LABELS } from "@/lib/types/kanban";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { Plus, Trash2, Check, Circle, Loader2, GitBranch, ChevronRight, GitMerge } from "lucide-react";
import { useState } from "react";

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
  } = useEpicDetail(projectId, epicId);

  const [newUSTitle, setNewUSTitle] = useState("");
  const [expandedUS, setExpandedUS] = useState<Set<string>>(new Set());
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
      <SheetContent className="w-[450px] sm:max-w-[450px] overflow-y-auto">
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

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-medium">
                    User Stories ({userStories.length})
                  </h4>
                </div>

                <div className="space-y-1">
                  {userStories.map((us) => {
                    const hasDetails = us.description || us.acceptanceCriteria;
                    const isExpanded = expandedUS.has(us.id);
                    return (
                      <div key={us.id} className="rounded hover:bg-accent/50 group">
                        <div className="flex items-center gap-2 p-2">
                          {hasDetails && (
                            <button
                              onClick={() =>
                                setExpandedUS((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(us.id)) next.delete(us.id);
                                  else next.add(us.id);
                                  return next;
                                })
                              }
                              className="shrink-0"
                            >
                              <ChevronRight
                                className={`h-3 w-3 text-muted-foreground transition-transform ${
                                  isExpanded ? "rotate-90" : ""
                                }`}
                              />
                            </button>
                          )}
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
                          <span
                            className={`flex-1 text-sm ${
                              us.status === "done"
                                ? "line-through text-muted-foreground"
                                : ""
                            }`}
                          >
                            {us.title}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100"
                            onClick={() => deleteUserStory(us.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                        {isExpanded && hasDetails && (
                          <div className="pl-10 pr-2 pb-2 space-y-2 text-sm">
                            {us.description && (
                              <div>
                                <MarkdownContent content={us.description} />
                              </div>
                            )}
                            {us.acceptanceCriteria && (
                              <div>
                                <span className="text-xs font-medium text-muted-foreground">
                                  Acceptance Criteria
                                </span>
                                <MarkdownContent content={us.acceptanceCriteria} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

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
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
