"use client";

import { Loader2 } from "lucide-react";

export type ImportProgressStep = "cloning" | "analyzing";

interface ImportProgressProps {
  /** Defaults to "analyzing" so the local-folder flow reads exactly as before. */
  step?: ImportProgressStep;
  /** `owner/repo` being cloned — named in the heading of the cloning step. */
  repo?: string | null;
}

export function ImportProgress({
  step = "analyzing",
  repo,
}: ImportProgressProps) {
  const cloning = step === "cloning";
  const heading = cloning
    ? `Cloning ${repo || "repository"}...`
    : "Analyzing project...";
  const detail = cloning
    ? "Fetching the full history from GitHub"
    : "Claude Code is scanning the codebase and generating epics";

  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-lg font-medium">{heading}</p>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}
