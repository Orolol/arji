"use client";

import { useEffect, useState } from "react";

/**
 * Checks if a project has GitHub integration configured.
 *
 * Returns:
 * - `isConfigured`: true if the project has `githubOwnerRepo` set and a PAT is stored
 * - `ownerRepo`: the "owner/repo" string, or null
 * - `tokenSet`: whether a GitHub PAT is stored in settings
 * - `loading`: true while the check is in progress
 */
export function useGitHubConfig(projectId: string | undefined) {
  const [isConfigured, setIsConfigured] = useState(false);
  const [ownerRepo, setOwnerRepo] = useState<string | null>(null);
  const [tokenSet, setTokenSet] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const [projectRes, settingsRes] = await Promise.all([
          fetch(`/api/projects/${projectId}`),
          fetch("/api/settings"),
        ]);

        const projectData = await projectRes.json();
        const settingsData = await settingsRes.json();

        if (cancelled) return;

        const repo = projectData.data?.githubOwnerRepo ?? null;
        // GET /api/settings never returns the PAT: it masks `github_pat`
        // down to `{ hasToken: boolean }`. Testing it as a string made
        // `tokenSet`/`isConfigured` permanently false.
        const hasToken = settingsData.data?.github_pat?.hasToken === true;

        setOwnerRepo(repo);
        setTokenSet(hasToken);
        setIsConfigured(Boolean(repo && hasToken));
      } catch {
        if (!cancelled) {
          setOwnerRepo(null);
          setTokenSet(false);
          setIsConfigured(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return { isConfigured, ownerRepo, tokenSet, loading };
}
