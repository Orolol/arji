"use client";

import { useTranslations } from "next-intl";

import { useState, useEffect, useCallback } from "react";
import type { FileDiff, DiffMetadata } from "@/lib/git/diff";

export function useDiff(projectId: string, epicId: string | null) {
  const tErrors = useTranslations("ClientErrors");
  const [files, setFiles] = useState<FileDiff[]>([]);
  const [metadata, setMetadata] = useState<DiffMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!epicId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/epics/${epicId}/diff`
      );
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setFiles([]);
        setMetadata(null);
      } else {
        setFiles(data.data?.files || []);
        setMetadata(data.data?.metadata || null);
      }
    } catch {
      setError(tErrors("failedToLoadDiff"));
      setFiles([]);
      setMetadata(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, epicId, tErrors]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  return { files, metadata, loading, error, refresh: fetchDiff };
}
