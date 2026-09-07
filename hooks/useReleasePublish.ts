import { useState, useCallback } from "react";

import { useTranslations } from "next-intl";

interface UseReleasePublishReturn {
  publish: (releaseId: string) => Promise<boolean>;
  isPublishing: boolean;
  error: string | null;
}

/**
 * Manages the publish action for a draft GitHub release.
 */
export function useReleasePublish(projectId: string): UseReleasePublishReturn {
  const tErrors = useTranslations("ClientErrors");
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
          setError(data.error || tErrors("failedToPublishRelease"));
          return false;
        }

        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : tErrors("networkError");
        setError(msg);
        return false;
      } finally {
        setIsPublishing(false);
      }
    },
    [projectId, tErrors]
  );

  return { publish, isPublishing, error };
}
