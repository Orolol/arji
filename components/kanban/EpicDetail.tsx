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
import { Plus, Trash2, Check, Circle, Loader2, GitBranch } from "lucide-react";
import { useState } from "react";
import Link from "next/link";

interface EpicDetailProps {
  projectId: string;
  epicId: string | null;
  open: boolean;
  onClose: () => void;
}

export function EpicDetail({ projectId, epicId, open, onClose }: EpicDetailProps) {
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
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-mono">
                  <GitBranch className="h-3 w-3" />
                  {epic.branchName}
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
