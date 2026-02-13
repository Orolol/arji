"use client";

import { useEffect, useState } from "react";

/**
 * Checks if a project has GitHub integration configured.
 *
 * Returns:
 * - `isConfigured`: true if the project has `githubOwnerRepo` set
 * - `ownerRepo`: the "owner/repo" string, or null
 * - `loading`: true while the check is in progress
 */
export function useGitHubConfig(projectId: string | undefined) {
  const [isConfigured, setIsConfigured] = useState(false);
  const [ownerRepo, setOwnerRepo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }

    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        const repo = d.data?.githubOwnerRepo ?? null;
        setOwnerRepo(repo);
        setIsConfigured(!!repo);
      })
      .catch(() => {
        setOwnerRepo(null);
        setIsConfigured(false);
      })
      .finally(() => setLoading(false));
  }, [projectId]);

  return { isConfigured, ownerRepo, loading };
}
