"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useEpicPr } from "@/hooks/useEpicPr";
import {
  GitPullRequest,
  ExternalLink,
  RefreshCw,
  Loader2,
  AlertCircle,
} from "lucide-react";

interface EpicPrControlsProps {
  projectId: string;
  epicId: string;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  branchName: string | null;
  isRunning: boolean;
  onPrUpdate: (pr: {
    prNumber: number | null;
    prUrl: string | null;
    prStatus: string | null;
  }) => void;
}

const PR_STATUS_STYLES: Record<string, string> = {
  open: "bg-green-500/10 text-green-500 border-green-500/30",
  draft: "bg-muted text-muted-foreground border-border",
  closed: "bg-red-500/10 text-red-500 border-red-500/30",
  merged: "bg-purple-500/10 text-purple-500 border-purple-500/30",
};

const PR_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  draft: "Draft",
  closed: "Closed",
  merged: "Merged",
};

export function EpicPrControls({
  projectId,
  epicId,
  prNumber,
  prUrl,
  prStatus,
  branchName,
  isRunning,
  onPrUpdate,
}: EpicPrControlsProps) {
  const { creating, syncing, error, hint, createPr, syncPrStatus } = useEpicPr(
    projectId,
    epicId
  );

  const busy = creating || syncing;

  async function handleCreatePr() {
    const result = await createPr();
    if (result) {
      onPrUpdate(result);
    }
  }

  async function handleSyncStatus() {
    const result = await syncPrStatus();
    if (result) {
      onPrUpdate(result);
    }
  }

  // No branch = can't create PR
  if (!branchName) return null;

  return (
    <div className="space-y-2">
      {!prNumber ? (
        // No PR exists yet — show create button
        <Button
          size="sm"
          variant="outline"
          onClick={handleCreatePr}
          disabled={busy || isRunning}
          className="h-7 text-xs"
        >
          {creating ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <GitPullRequest className="h-3 w-3 mr-1" />
          )}
          Push & Create PR
        </Button>
      ) : (
        // PR exists — show status and controls
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={prUrl || "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
          >
            <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-mono text-muted-foreground">
              #{prNumber}
            </span>
            <Badge
              variant="outline"
              className={`text-xs ${PR_STATUS_STYLES[prStatus || "open"] || PR_STATUS_STYLES.open}`}
            >
              {PR_STATUS_LABELS[prStatus || "open"] || prStatus}
            </Badge>
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          </a>

          <Button
            size="sm"
            variant="ghost"
            onClick={handleSyncStatus}
            disabled={busy || isRunning}
            className="h-6 w-6 p-0"
            title="Sync PR status from GitHub"
          >
            {syncing ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          </Button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-1.5 text-xs">
          <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="text-destructive">{error}</p>
            {hint && (
              <p className="text-muted-foreground mt-0.5">{hint}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
