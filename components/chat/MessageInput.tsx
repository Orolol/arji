"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, ImagePlus, X, Loader2 } from "lucide-react";

export interface PendingAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  previewUrl: string;
}

interface MessageInputProps {
  projectId: string;
  onSend: (content: string, attachmentIds: string[]) => void;
  disabled?: boolean;
}

export function MessageInput({ projectId, onSend, disabled }: MessageInputProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(
    async (file: File): Promise<PendingAttachment | null> => {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch(`/api/projects/${projectId}/chat/upload`, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) return null;

        const { data } = await res.json();
        return {
          id: data.id,
          fileName: data.fileName,
          mimeType: data.mimeType,
          previewUrl: `/api/projects/${projectId}/chat/uploads/${data.id}`,
        };
      } catch {
        return null;
      }
    },
    [projectId]
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      setUploading(true);
      const results = await Promise.all(files.map(uploadFile));
      const successful = results.filter((r): r is PendingAttachment => r !== null);
      setAttachments((prev) => [...prev, ...successful]);
      setUploading(false);
    },
    [uploadFile]
  );

  function handleSubmit() {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled || uploading) return;
    onSend(trimmed, attachments.map((a) => a.id));
    setValue("");
    setAttachments([]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          const ext = file.type.split("/")[1] || "png";
          const named = new File([file], `pasted-image-${Date.now()}.${ext}`, {
            type: file.type,
          });
          imageFiles.push(named);
        }
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault();
      uploadFiles(imageFiles);
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files?.length) return;
    uploadFiles(Array.from(files));
    e.target.value = "";
  }

  const hasContent = value.trim().length > 0 || attachments.length > 0;

  return (
    <div className="p-3 border-t border-border">
      {/* Attachment preview strip */}
      {(attachments.length > 0 || uploading) && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((att) => (
            <div key={att.id} className="relative group">
              <img
                src={att.previewUrl}
                alt={att.fileName}
                className="h-16 w-16 object-cover rounded-md border border-border"
              />
              <button
                onClick={() => removeAttachment(att.id)}
                className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                type="button"
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
      )}

      <div className="flex gap-2">
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="Type a message..."
          rows={2}
          className="resize-none text-sm"
          disabled={disabled}
        />
        <div className="flex flex-col gap-1 shrink-0">
          <Button
            size="icon"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading}
            title="Attach image"
            type="button"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ImagePlus className="h-4 w-4" />
            )}
          </Button>
          <Button
            size="icon"
            onClick={handleSubmit}
            disabled={disabled || !hasContent || uploading}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept="image/png,image/jpg,image/jpeg,image/gif,image/webp"
        multiple
        onChange={handleFileSelect}
      />
    </div>
  );
}
