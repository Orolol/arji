"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MentionTextarea } from "@/components/documents/MentionTextarea";
import { ImageAttachmentStrip } from "@/components/shared/ImageAttachmentStrip";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import { ArrowRight, ImagePlus, Loader2 } from "lucide-react";

export type { PendingAttachment } from "@/hooks/useImageAttachments";

interface MessageInputProps {
  projectId: string;
  onSend: (content: string, attachmentIds: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  /**
   * Disables the image-attach button, paste-to-attach, and file picker.
   * Set when the active conversation runs on a provider that cannot take
   * image attachments (OpenAI-compatible fast mode).
   */
  attachmentsDisabled?: boolean;
}

export function MessageInput({
  projectId,
  onSend,
  disabled,
  placeholder = "Ask a question...",
  attachmentsDisabled = false,
}: MessageInputProps) {
  const [value, setValue] = useState("");
  const {
    attachments,
    uploading,
    fileInputProps,
    openFilePicker,
    handlePaste,
    remove: removeAttachment,
    clear: clearAttachments,
  } = useImageAttachments({ projectId, disabled: attachmentsDisabled });

  const effectiveAttachments = attachmentsDisabled ? [] : attachments;

  function handleSubmit() {
    const trimmed = value.trim();
    if ((!trimmed && effectiveAttachments.length === 0) || disabled || uploading) return;
    onSend(trimmed, effectiveAttachments.map((a) => a.id));
    setValue("");
    if (!attachmentsDisabled) {
      clearAttachments();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const hasContent = value.trim().length > 0 || effectiveAttachments.length > 0;

  return (
    <div className="border-t border-border px-[18px] py-[14px]">
      {/* Attachment preview strip */}
      <ImageAttachmentStrip
        attachments={effectiveAttachments}
        onRemove={removeAttachment}
        uploading={uploading}
        className="mb-2"
      />

      <div className="flex items-end gap-[10px]">
        <MentionTextarea
          projectId={projectId}
          value={value}
          onValueChange={setValue}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={2}
          className="min-h-[54px] resize-none rounded-[8px] text-[13.5px]"
          disabled={disabled}
        />
        <div className="flex shrink-0 flex-col gap-[6px]">
          <Button
            size="icon"
            variant="outline"
            onClick={openFilePicker}
            disabled={disabled || uploading || attachmentsDisabled}
            title="Attach image"
            type="button"
            className="h-[30px] w-[30px] rounded-[8px]"
          >
            {uploading ? (
              <Loader2 className="h-[14px] w-[14px] animate-spin" />
            ) : (
              <ImagePlus className="h-[14px] w-[14px]" />
            )}
          </Button>
          <Button
            size="icon"
            onClick={handleSubmit}
            disabled={disabled || !hasContent || uploading}
            aria-label="Send message"
            className="h-[30px] w-[30px] rounded-[8px] bg-primary"
          >
            <ArrowRight className="h-[14px] w-[14px]" />
          </Button>
        </div>
      </div>

      <input {...fileInputProps} />
    </div>
  );
}
