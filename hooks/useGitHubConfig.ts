import { useEffect, useState } from "react";

interface GitHubConfig {
  configured: boolean;
  ownerRepo: string | null;
  tokenSet: boolean;
  loading: boolean;
}

/**
 * Fetches the project's GitHub configuration (ownerRepo) and whether
 * a GitHub PAT is stored in settings.
 */
export function useGitHubConfig(projectId: string): GitHubConfig {
  const [config, setConfig] = useState<GitHubConfig>({
    configured: false,
    ownerRepo: null,
    tokenSet: false,
    loading: true,
  });

  useEffect(() => {
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

        const ownerRepo = projectData.data?.githubOwnerRepo || null;
        const tokenSet =
          typeof settingsData.data?.github_pat === "string" &&
          settingsData.data.github_pat.length > 0;

        setConfig({
          configured: Boolean(ownerRepo && tokenSet),
          ownerRepo,
          tokenSet,
          loading: false,
        });
      } catch {
        if (!cancelled) {
          setConfig((prev) => ({ ...prev, loading: false }));
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return config;
}
