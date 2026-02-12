import { useState, useCallback } from "react";

interface UseReleasePublishReturn {
  publish: (releaseId: string) => Promise<boolean>;
  isPublishing: boolean;
  error: string | null;
}

/**
 * Manages the publish action for a draft GitHub release.
 */
export function useReleasePublish(projectId: string): UseReleasePublishReturn {
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = useCallback(
    async (releaseId: string): Promise<boolean> => {
      setIsPublishing(true);
      setError(null);

      try {
        const res = await fetch(
          `/api/projects/${projectId}/releases/${releaseId}/publish`,
          { method: "POST" }
        );

        const data = await res.json();

        if (!res.ok) {
          setError(data.error || "Failed to publish release");
          return false;
        }

        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Network error";
        setError(msg);
        return false;
      } finally {
        setIsPublishing(false);
      }
    },
    [projectId]
  );

  return { publish, isPublishing, error };
}
