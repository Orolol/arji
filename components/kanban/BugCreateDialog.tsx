"use client";

import { useId, useRef, useState } from "react";
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
import { ImageAttachmentStrip } from "@/components/shared/ImageAttachmentStrip";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import { PRIORITY_LABELS } from "@/lib/types/kanban";
import { apiErrorMessage } from "@/lib/validation/error-message";
import { cn } from "@/lib/utils";
import { ImagePlus, Loader2 } from "lucide-react";

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
  const fieldId = useId();
  const titleId = `${fieldId}-title`;
  const descriptionId = `${fieldId}-description`;
  const priorityId = `${fieldId}-priority`;
  const screenshotsLabelId = `${fieldId}-screenshots-label`;
  const screenshotsHintId = `${fieldId}-screenshots-hint`;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("2");
  const [submitMode, setSubmitMode] = useState<"create" | "create_and_fix" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = submitMode !== null;
  // Enter in the title field calls handleSubmit straight through, and a
  // disabled button does not stand in its way. `submitting` only turns true a
  // render later, so the guard that keeps a second press from filing the same
  // report twice has to be synchronous.
  const submitLockRef = useRef(false);

  const {
    attachments,
    uploading,
    error: attachmentError,
    dragActive,
    fileInputProps,
    openFilePicker,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    remove: removeAttachment,
    clear: clearAttachments,
    discardAll: discardAttachments,
  } = useImageAttachments({ projectId });

  function resetForm() {
    setTitle("");
    setDescription("");
    setPriority("2");
    // `clear`, not `discardAll`: this runs after the report was filed, and the
    // bug now owns those uploads. Discarding them here would delete the
    // screenshots off the ticket that was just created with them.
    clearAttachments();
  }

  /**
   * Closing without filing anything. The screenshots were uploaded the moment
   * they were pasted, so an abandoned form leaves real files on disk unless
   * they are thrown away here.
   *
   * The typed title and description are left alone — a draft has always
   * survived a cancel, and that is unrelated to the uploads.
   *
   * Nothing is discarded while a submit is in flight: those uploads are on
   * their way to becoming a ticket's, and Escape during the request must not
   * race the claim for them.
   */
  function handleOpenChange(next: boolean) {
    if (!next && !submitting) {
      discardAttachments();
    }
    onOpenChange(next);
  }

  async function handleSubmit(mode: "create" | "create_and_fix" = "create") {
    if (submitLockRef.current || !title.trim() || uploading) return;
    submitLockRef.current = true;
    setSubmitMode(mode);
    setError(null);

    const images = attachments.map((a) => a.filePath).filter(Boolean);

    try {
      const createRes = await fetch(`/api/projects/${projectId}/bugs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          priority: Number(priority),
          // Omitted entirely when nothing is attached, so a bug without a
          // screenshot posts exactly the payload it posted before.
          ...(images.length > 0 ? { images } : {}),
        }),
      });

      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok || createData.error) {
        // Through apiErrorMessage so a rejected field says which one and why,
        // instead of the schema layer's bare "Validation failed".
        setError(apiErrorMessage(createData, "Failed to create bug"));
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
      submitLockRef.current = false;
      setSubmitMode(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* The whole modal is the paste and drop target, not just the fields:
          a screenshot dropped on the header or the footer must not fall
          through to the browser, which would navigate away to the file and
          take the half-written report with it. */}
      <DialogContent
        className={cn(
          "rounded-[14px] shadow-[0_18px_40px_rgba(58,48,44,.14)] transition-colors sm:max-w-[480px]",
          dragActive && "outline-2 outline-dashed outline-primary/60"
        )}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        data-testid="bug-create-drop-zone"
      >
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold">New Bug</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label
              htmlFor={titleId}
              className="mb-1 block text-[12.5px] text-muted-foreground"
            >
              Title *
            </label>
            <Input
              id={titleId}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Bug title..."
              onKeyDown={(e) => e.key === "Enter" && handleSubmit("create")}
              autoFocus
            />
          </div>

          <div>
            <label
              htmlFor={descriptionId}
              className="mb-1 block text-[12.5px] text-muted-foreground"
            >
              Description
            </label>
            <Textarea
              id={descriptionId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Steps to reproduce, expected vs actual behavior..."
              rows={4}
            />
          </div>

          <div
            role="group"
            aria-labelledby={screenshotsLabelId}
            aria-describedby={screenshotsHintId}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span
                id={screenshotsLabelId}
                className="text-[12.5px] text-muted-foreground"
              >
                Screenshots
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={openFilePicker}
                disabled={submitting || uploading}
                className="h-[26px] rounded-[7px] px-2 text-[12px]"
              >
                <ImagePlus className="mr-1 h-3 w-3" />
                Attach image
              </Button>
            </div>

            <ImageAttachmentStrip
              attachments={attachments}
              onRemove={removeAttachment}
              uploading={uploading}
              className="mb-2"
            />

            <p
              id={screenshotsHintId}
              className="text-[11.5px] text-muted-foreground"
            >
              Paste a screenshot with Ctrl/Cmd+V, drop an image here, or attach one.
            </p>

            {attachmentError && (
              <p className="mt-1 text-xs text-destructive" role="alert">
                {attachmentError}
              </p>
            )}

            <input {...fileInputProps} />
          </div>

          <div>
            <label
              htmlFor={priorityId}
              className="mb-1 block text-[12.5px] text-muted-foreground"
            >
              Priority
            </label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger
                id={priorityId}
                className="h-[29px] rounded-[7px] text-[12.5px]"
              >
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
            onClick={() => handleOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => handleSubmit("create")}
            disabled={!title.trim() || submitting || uploading}
            variant="destructive"
          >
            {submitMode === "create" && (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            )}
            Create Bug
          </Button>
          <Button
            onClick={() => handleSubmit("create_and_fix")}
            disabled={!title.trim() || submitting || uploading}
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
