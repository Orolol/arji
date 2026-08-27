"use client";

import { useState, useRef, useCallback } from "react";

interface UseEpicMutationsOptions {
  /** Called after a successful merge (before merging state resets). */
  onMergeSuccess?: () => void;
  /** Called after a successful delete (before deleting state resets). */
  onDeleteSuccess?: () => void;
}

/**
 * Owns the merge-into-main and permanent-delete mutations for an epic.
 * Fetch calls and their loading/error state live here; the component only
 * wires callbacks and renders the state.
 */
export function useEpicMutations(
  projectId: string,
  epicId: string | null,
  { onMergeSuccess, onDeleteSuccess }: UseEpicMutationsOptions = {}
) {
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeConflict, setMergeConflict] = useState(false);
  const [conflictFiles, setConflictFiles] = useState<string[] | undefined>(undefined);
  const [deletingEpic, setDeletingEpic] = useState(false);
  const [deleteEpicError, setDeleteEpicError] = useState<string | null>(null);
  const deleteInFlightRef = useRef(false);

  const merge = useCallback(async () => {
    if (!epicId) return;
    setMerging(true);
    setMergeError(null);
    setMergeConflict(false);
    setConflictFiles(undefined);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/epics/${epicId}/merge`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        setMergeError(data.error || "Failed to merge");
        const isConflict = data.reason === "conflict" || data.mergeFailed === true;
        setMergeConflict(isConflict);
        if (Array.isArray(data.conflictFiles) && data.conflictFiles.length > 0) {
          setConflictFiles(data.conflictFiles);
        }
      } else {
        onMergeSuccess?.();
      }
    } catch {
      setMergeError("Failed to merge");
      setMergeConflict(false);
      setConflictFiles(undefined);
    }
    setMerging(false);
  }, [projectId, epicId, onMergeSuccess]);

  const deleteEpic = useCallback(async () => {
    if (!epicId || deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    setDeletingEpic(true);
    setDeleteEpicError(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/epics/${epicId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.error) {
        setDeleteEpicError(data.error || "Failed to delete epic");
        return;
      }

      onDeleteSuccess?.();
    } catch {
      setDeleteEpicError("Failed to delete epic");
    } finally {
      deleteInFlightRef.current = false;
      setDeletingEpic(false);
    }
  }, [projectId, epicId, onDeleteSuccess]);

  return {
    merging,
    mergeError,
    mergeConflict,
    conflictFiles,
    setMergeError,
    merge,
    deletingEpic,
    deleteEpicError,
    deleteEpic,
  };
}
