"use client";

import { useTranslations } from "next-intl";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PendingAttachment } from "@/hooks/useImageAttachments";

interface ImageAttachmentStripProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
  /** Renders a placeholder tile while an upload is in flight. */
  uploading?: boolean;
  className?: string;
}

/**
 * Thumbnails for staged image attachments, each removable on its own.
 * Shared by the chat composer and the bug creation modal.
 */
export function ImageAttachmentStrip({
  attachments,
  onRemove,
  uploading = false,
  className,
}: ImageAttachmentStripProps) {
  const t = useTranslations("Shared");
  if (attachments.length === 0 && !uploading) return null;

  return (
    <div
      className={cn("flex flex-wrap gap-2", className)}
      data-testid="image-attachment-strip"
    >
      {attachments.map((attachment) => (
        <div key={attachment.id} className="relative group">
          <img
            src={attachment.previewUrl}
            alt={attachment.fileName}
            className="h-16 w-16 object-cover rounded-md border border-border"
          />
          <button
            onClick={() => onRemove(attachment.id)}
            className="absolute -top-1.5 -right-1.5 bg-destructive text-background rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            type="button"
            aria-label={t("imageAttachments.remove", {
              fileName: attachment.fileName,
            })}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {uploading && (
        <div className="h-16 w-16 rounded-md border border-border flex items-center justify-center bg-muted">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
