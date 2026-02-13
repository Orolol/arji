"use client";

import { useState, useCallback } from "react";
import { Upload, Loader2 } from "lucide-react";

interface UploadZoneProps {
  projectId: string;
  onUploaded: () => void;
}

export function UploadZone({ projectId, onUploaded }: UploadZoneProps) {
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
            body.error || `Failed to upload "${file.name}" (HTTP ${res.status})`
          );
          break;
        }
      }
      setUploading(false);
      onUploaded();
    },
    [projectId, onUploaded]
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
      className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
        dragOver
          ? "border-primary bg-primary/5"
          : "border-border hover:border-muted-foreground"
      }`}
    >
      {uploading ? (
        <div className="flex items-center justify-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Uploading...</span>
        </div>
      ) : (
        <label className="cursor-pointer">
          <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Drag & drop files here, or click to select
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            PDF, DOCX, MD, TXT, and images
          </p>
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
      {error && <p className="text-xs text-destructive mt-3">{error}</p>}
    </div>
  );
}
