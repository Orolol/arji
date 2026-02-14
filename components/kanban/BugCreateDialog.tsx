"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PRIORITY_LABELS } from "@/lib/types/kanban";
import { Loader2 } from "lucide-react";

interface BugCreateDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
  namedAgentId?: string | null;
}

export function BugCreateDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
  namedAgentId = null,
}: BugCreateDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("2");
  const [submitMode, setSubmitMode] = useState<"create" | "create_and_fix" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = submitMode !== null;

  function resetForm() {
    setTitle("");
    setDescription("");
    setPriority("2");
  }

  async function handleSubmit(mode: "create" | "create_and_fix" = "create") {
    if (!title.trim()) return;
    setSubmitMode(mode);
    setError(null);

    try {
      const createRes = await fetch(`/api/projects/${projectId}/bugs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          priority: Number(priority),
        }),
      });

      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok || createData.error) {
        setError(createData.error || "Failed to create bug");
        return;
      }

      const createdBugId = createData?.data?.id as string | undefined;
      if (mode === "create_and_fix") {
        if (!createdBugId) {
          setError("Bug created, but failed to start fix agent: missing bug ID");
          resetForm();
          onCreated?.();
          return;
        }

        const buildRes = await fetch(
          `/api/projects/${projectId}/epics/${createdBugId}/build`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ namedAgentId }),
          }
        );
        const buildData = await buildRes.json().catch(() => ({}));
        if (!buildRes.ok || buildData.error) {
          const reason = buildData.error ? `: ${buildData.error}` : "";
          setError(`Bug created, but failed to start fix agent${reason}`);
          resetForm();
          onCreated?.();
          return;
        }
      }

      resetForm();
      onOpenChange(false);
      onCreated?.();
    } catch {
      setError(
        mode === "create_and_fix"
          ? "Failed to create bug and start fix agent"
          : "Failed to create bug"
      );
    } finally {
      setSubmitMode(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>New Bug</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Title *
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Bug title..."
              onKeyDown={(e) => e.key === "Enter" && handleSubmit("create")}
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Description
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Steps to reproduce, expected vs actual behavior..."
              rows={4}
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Priority
            </label>
            <Select value={priority} onValueChange={setPriority}>
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

          {error && (
            <p className="text-xs text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => handleSubmit("create")}
            disabled={!title.trim() || submitting}
            variant="destructive"
          >
            {submitMode === "create" && (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            )}
            Create Bug
          </Button>
          <Button
            onClick={() => handleSubmit("create_and_fix")}
            disabled={!title.trim() || submitting}
            variant="destructive"
          >
            {submitMode === "create_and_fix" && (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            )}
            Create And Fix
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
