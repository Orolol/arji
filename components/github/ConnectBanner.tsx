"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

interface ConnectBannerProps {
  projectId: string;
  gitRepoPath: string | null;
  githubOwnerRepo: string | null;
  onConnected?: (ownerRepo: string) => void;
}

const DISMISS_KEY_PREFIX = "arij:github-connect-dismissed:";

export function ConnectBanner({
  projectId,
  gitRepoPath,
  githubOwnerRepo,
  onConnected,
}: ConnectBannerProps) {
  const [dismissed, setDismissed] = useState(true);
  const [detected, setDetected] = useState<{
    owner: string;
    repo: string;
  } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Don't show if already connected or no git repo
  const shouldShow = gitRepoPath && !githubOwnerRepo;

  useEffect(() => {
    if (!shouldShow) return;

    const key = `${DISMISS_KEY_PREFIX}${projectId}`;
    const wasDismissed = localStorage.getItem(key) === "true";
    setDismissed(wasDismissed);

    if (!wasDismissed) {
      handleDetect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, shouldShow]);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/projects/${projectId}/git/detect-remote`,
        { method: "POST" }
      );
      const data = await res.json();

      if (res.ok && data.data) {
        setDetected(data.data);
      } else {
        setError(data.message || "Could not detect remote.");
      }
    } catch {
      setError("Failed to detect remote.");
    } finally {
      setDetecting(false);
    }
  }, [projectId]);

  async function handleConnect() {
    if (!detected) return;

    setConnecting(true);
    setError(null);

    try {
      const ownerRepo = `${detected.owner}/${detected.repo}`;
      const res = await fetch(`/api/projects/${projectId}/git/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerRepo }),
      });

      const data = await res.json();

      if (res.ok) {
        onConnected?.(ownerRepo);
      } else {
        setError(data.message || "Failed to connect.");
      }
    } catch {
      setError("Failed to connect.");
    } finally {
      setConnecting(false);
    }
  }

  function handleDismiss() {
    const key = `${DISMISS_KEY_PREFIX}${projectId}`;
    localStorage.setItem(key, "true");
    setDismissed(true);
  }

  if (!shouldShow || dismissed) return null;

  return (
    <div className="border border-blue-500/30 bg-blue-500/5 rounded-lg p-4 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h3 className="text-sm font-medium mb-1">
            Connect to GitHub
          </h3>
          {detecting ? (
            <p className="text-sm text-muted-foreground">
              Detecting remote...
            </p>
          ) : detected ? (
            <p className="text-sm text-muted-foreground">
              Detected remote:{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">
                {detected.owner}/{detected.repo}
              </code>
            </p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {detected && (
            <Button
              size="sm"
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting ? "Connecting..." : "Connect"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDismiss}
          >
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
