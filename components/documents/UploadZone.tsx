"use client";

import { useTranslations } from "next-intl";
import { useState, useCallback } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface UploadZoneProps {
  projectId: string;
  onUploaded: () => void;
}

export function UploadZone({ projectId, onUploaded }: UploadZoneProps) {
  const t = useTranslations("Documents");
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: FileList) => {
      setUploading(true);
      setError(null);
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch(`/api/projects/${projectId}/documents`, {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(
            body.error || t("errors.uploadFailed", { name: file.name, status: res.status })
          );
          break;
        }
      }
      setUploading(false);
      onUploaded();
    },
    [projectId, onUploaded, t]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex w-[252px] max-w-full flex-col justify-center gap-[8px] rounded-[12px] border border-dashed p-[16px] transition-colors",
        dragOver ? "border-primary bg-primary/5" : "border-border"
      )}
    >
      {uploading ? (
        <div className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("upload.uploading")}</span>
        </div>
      ) : (
        <label className="flex cursor-pointer flex-col gap-[8px]">
          <span className="text-[13.5px] font-medium text-primary">
            {t("upload.prompt")}
          </span>
          <span className="text-[12.5px] text-muted-foreground">
            {t("upload.formats")}
          </span>
          <input
            type="file"
            className="hidden"
            multiple
            accept=".pdf,.docx,.md,.txt,image/*"
            onChange={(e) => {
              if (e.target.files?.length) handleFiles(e.target.files);
            }}
          />
        </label>
      )}
      {error && <p className="mt-1 text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
