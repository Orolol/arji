"use client";

import { useCallback, useRef, useState } from "react";
import {
  IMAGE_UPLOAD_ACCEPT,
  formatImageRejections,
  imageFilesFromClipboard,
  imageFilesFromDrop,
  partitionImageFiles,
} from "@/lib/uploads/image-attachments";

export interface PendingAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  /** Repo-relative path on disk, e.g. `data/uploads/<projectId>/<file>`. */
  filePath: string;
  previewUrl: string;
}

export interface UseImageAttachmentsOptions {
  projectId: string;
  /**
   * Makes every entry point inert without discarding what is already staged.
   * Set by the chat composer when the active provider cannot take images.
   */
  disabled?: boolean;
}

interface UploadOutcome {
  attachment?: PendingAttachment;
  error?: string;
}

/**
 * Staging area for image attachments: upload transfer, clipboard paste, drag
 * and drop, the file picker, and per-item removal.
 *
 * Shared by the chat composer (`MessageInput`) and the bug creation modal
 * (`BugCreateDialog`) so the transfer to `/chat/upload` exists in one place.
 */
export function useImageAttachments({
  projectId,
  disabled = false,
}: UseImageAttachmentsOptions) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Counted rather than a flag: paste and drop stay live during a transfer, so
  // batches overlap as soon as the user pastes twice without waiting.
  const [pendingUploads, setPendingUploads] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Bumped by `clear()`. Everything still in flight belongs to the staging area
  // that just ended, and must not land in the empty one that replaced it.
  const stagingSessionRef = useRef(0);

  const uploading = pendingUploads > 0;

  /**
   * Tells the server the upload is not wanted after all.
   *
   * Fire-and-forget: the thumbnail is already gone from the strip and the user
   * has nothing to do about a failure. The route refuses anything a ticket or
   * a message has since claimed, so the worst case is a file that outlives its
   * form — never one deleted out from under a report that was filed with it.
   */
  const discardUpload = useCallback(
    (id: string) => {
      void fetch(`/api/projects/${projectId}/chat/uploads/${id}`, {
        method: "DELETE",
      }).catch(() => {});
    },
    [projectId]
  );

  const uploadFile = useCallback(
    async (file: File): Promise<UploadOutcome> => {
      const formData = new FormData();
      formData.append("file", file);

      try {
        const res = await fetch(`/api/projects/${projectId}/chat/upload`, {
          method: "POST",
          body: formData,
        });

        const json = await res
          .json()
          .catch(() => ({} as { data?: PendingAttachment; error?: string }));

        if (!res.ok || !json?.data) {
          return { error: `${file.name}: ${json?.error || "upload failed"}` };
        }

        const data = json.data;
        return {
          attachment: {
            id: data.id,
            fileName: data.fileName,
            mimeType: data.mimeType,
            filePath: data.filePath ?? "",
            previewUrl: `/api/projects/${projectId}/chat/uploads/${data.id}`,
          },
        };
      } catch {
        return { error: `${file.name}: upload failed` };
      }
    },
    [projectId]
  );

  const uploadAccepted = useCallback(
    async (accepted: File[]) => {
      if (accepted.length === 0) return;

      const session = stagingSessionRef.current;
      setPendingUploads((pending) => pending + 1);

      let outcomes: UploadOutcome[] = [];
      try {
        outcomes = await Promise.all(accepted.map(uploadFile));
      } finally {
        // A cleared session already zeroed the counter; decrementing on its
        // behalf would drive the next transfer's count negative.
        if (stagingSessionRef.current === session) {
          setPendingUploads((pending) => pending - 1);
        }
      }

      // Answered into a form the caller has since submitted and reset. Staging
      // it now would attach a screenshot the user never sees to whatever they
      // write next — and leaving it alone would strand the file, since nothing
      // that survives this call knows it exists.
      if (stagingSessionRef.current !== session) {
        for (const outcome of outcomes) {
          if (outcome.attachment) discardUpload(outcome.attachment.id);
        }
        return;
      }

      const uploaded = outcomes
        .map((outcome) => outcome.attachment)
        .filter((attachment): attachment is PendingAttachment => Boolean(attachment));
      if (uploaded.length > 0) {
        setAttachments((prev) => [...prev, ...uploaded]);
      }

      const failures = outcomes
        .map((outcome) => outcome.error)
        .filter((message): message is string => Boolean(message));
      if (failures.length > 0) {
        setError((prev) => [prev, ...failures].filter(Boolean).join(" · "));
      }
    },
    [discardUpload, uploadFile]
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (disabled || files.length === 0) return;
      const { accepted, rejected } = partitionImageFiles(files);
      setError(formatImageRejections(rejected));
      void uploadAccepted(accepted);
    },
    [disabled, uploadAccepted]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (disabled) return;

      const files = imageFilesFromClipboard(e.clipboardData);
      if (files.length === 0) return;

      const { accepted, rejected } = partitionImageFiles(files);
      setError(formatImageRejections(rejected));
      // Only swallow the paste when an image actually lands; the text the
      // clipboard also carries must still reach the field otherwise.
      if (accepted.length > 0) {
        e.preventDefault();
        void uploadAccepted(accepted);
      }
    },
    [disabled, uploadAccepted]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      const types = e.dataTransfer?.types;
      if (types && !Array.from(types).includes("Files")) return;
      e.preventDefault();
      setDragActive(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // dragleave also fires when the pointer crosses from one child to the
    // next, so dropping the highlight on those would make it flicker all the
    // way across the drop zone. Only a leave that lands outside counts.
    const movingTo = e.relatedTarget;
    if (movingTo instanceof Node && e.currentTarget.contains(movingTo)) return;
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      const files = imageFilesFromDrop(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      setDragActive(false);
      addFiles(files);
    },
    [addFiles, disabled]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files?.length) {
        addFiles(Array.from(files));
      }
      e.target.value = "";
    },
    [addFiles]
  );

  const openFilePicker = useCallback(() => {
    if (disabled) return;
    fileInputRef.current?.click();
  }, [disabled]);

  const remove = useCallback(
    (id: string) => {
      setAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
      // Taking a thumbnail out of the strip is the user saying they do not
      // want the screenshot. Nothing else ever refers to it again, so the file
      // has to go now or it never will.
      discardUpload(id);
    },
    [discardUpload]
  );

  /**
   * Empties the staging area for a form that has *succeeded*: the uploads are
   * now owned by whatever was submitted, so the files stay.
   */
  const clear = useCallback(() => {
    stagingSessionRef.current += 1;
    setPendingUploads(0);
    setAttachments([]);
    setError(null);
  }, []);

  /**
   * Empties the staging area for a form that has been *abandoned*: nothing was
   * submitted, so nothing claimed these uploads and they are deleted.
   */
  const discardAll = useCallback(() => {
    for (const attachment of attachments) {
      discardUpload(attachment.id);
    }
    clear();
  }, [attachments, clear, discardUpload]);

  const fileInputProps = {
    ref: fileInputRef,
    type: "file" as const,
    className: "hidden",
    accept: IMAGE_UPLOAD_ACCEPT,
    multiple: true,
    onChange: handleFileSelect,
  };

  return {
    attachments,
    uploading,
    error,
    dragActive,
    fileInputProps,
    openFilePicker,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    remove,
    clear,
    discardAll,
  };
}
