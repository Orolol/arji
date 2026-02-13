"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

interface DetectionPayload {
  detected: boolean;
  owner?: string;
  repo?: string;
  ownerRepo?: string;
}

interface GitHubConnectBannerProps {
  projectId: string;
  gitRepoPath: string | null;
  githubOwnerRepo: string | null;
  onConnected?: (ownerRepo: string) => void;
}

function dismissStorageKey(projectId: string): string {
  return `github-connect-banner-dismissed:${projectId}`;
}

export function GitHubConnectBanner({
  projectId,
  gitRepoPath,
  githubOwnerRepo,
  onConnected,
}: GitHubConnectBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<DetectionPayload | null>(null);
  const shouldAttemptDetect = Boolean(gitRepoPath) && !githubOwnerRepo && !dismissed;

  const ownerRepo = useMemo(() => candidate?.ownerRepo ?? "", [candidate?.ownerRepo]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(window.localStorage.getItem(dismissStorageKey(projectId)) === "1");
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;

    async function runDetection() {
      if (!shouldAttemptDetect) {
        setCandidate(null);
        setError(null);
        return;
      }

      setDetecting(true);
      setError(null);
      try {
        const response = await fetch(`/api/projects/${projectId}/github/detect`);
        const payload = await response.json().catch(() => ({}));

        if (!response.ok) {
          if (!cancelled) {
            setError(
              payload?.error ??
                "Could not detect a GitHub remote for this project."
            );
          }
          return;
        }

        const data = payload?.data as DetectionPayload | undefined;
        if (!cancelled) {
          if (data?.detected && data.ownerRepo) {
            setCandidate(data);
          } else {
            setCandidate(null);
          }
        }
      } catch {
        if (!cancelled) {
          setError("Could not detect a GitHub remote for this project.");
        }
      } finally {
        if (!cancelled) {
          setDetecting(false);
        }
      }
    }

    runDetection();
    return () => {
      cancelled = true;
    };
  }, [projectId, shouldAttemptDetect]);

  function handleDismiss() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(dismissStorageKey(projectId), "1");
    }
    setDismissed(true);
    setError(null);
  }

  async function handleConnect() {
    if (!ownerRepo) return;
    setConnecting(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubOwnerRepo: ownerRepo }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(
          payload?.error ??
            "Failed to connect this project to the detected GitHub repository."
        );
        return;
      }

      if (typeof window !== "undefined") {
        window.localStorage.removeItem(dismissStorageKey(projectId));
      }

      onConnected?.(ownerRepo);
      setCandidate(null);
    } catch {
      setError(
        "Failed to connect this project to the detected GitHub repository."
      );
    } finally {
      setConnecting(false);
    }
  }

  if (!shouldAttemptDetect || !candidate?.ownerRepo) {
    return null;
  }

  return (
    <div className="border-b border-border bg-muted/40 px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm">
          Connect this project to <span className="font-mono">{candidate.ownerRepo}</span>?
        </p>
        <Button
          size="sm"
          className="h-7"
          onClick={handleConnect}
          disabled={connecting || detecting}
        >
          {connecting ? "Connecting..." : "Connect"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={handleDismiss}
          disabled={connecting}
        >
          Dismiss
        </Button>
        {detecting && <span className="text-xs text-muted-foreground">Detecting remote...</span>}
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
