"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ProjectSourceBadgeProps {
  /** Absolute path of the project's repository; null hides the whole strip. */
  gitRepoPath: string | null;
  /** "github" when Arij cloned the directory itself. */
  cloneSource: string | null;
  /** Clean origin URL recorded at clone time. */
  gitRemoteUrl: string | null;
  className?: string;
}

/** A clone URL is only worth linking when it points at a browsable https page. */
function browsableUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed.replace(/\.git$/i, "");
}

/** `https://github.com/owner/repo` → `owner/repo`, for a short link label. */
function linkLabel(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const path = pathname.replace(/^\/+|\/+$/g, "");
    return path || hostname;
  } catch {
    return url;
  }
}

/**
 * Where a project lives on disk, and where it came from.
 *
 * Answers the two questions the project header could not: the absolute path
 * (copyable in one click, because it is otherwise unselectable in a truncated
 * header) and whether Arij created that directory. Projects whose repository
 * the user supplied render the path alone, with no badge — deliberately
 * identical to how the header read before this existed.
 */
export function ProjectSourceBadge({
  gitRepoPath,
  cloneSource,
  gitRemoteUrl,
  className,
}: ProjectSourceBadgeProps) {
  const t = useTranslations("Layout");
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const copyPath = useCallback(async () => {
    if (!gitRepoPath) return;
    try {
      await navigator.clipboard.writeText(gitRepoPath);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard denied (insecure context, permissions) — the path stays
      // visible in the tooltip, which is the fallback that always works.
    }
  }, [gitRepoPath]);

  if (!gitRepoPath) return null;

  const isManagedClone = cloneSource === "github";
  const sourceUrl = isManagedClone ? browsableUrl(gitRemoteUrl) : null;

  return (
    <TooltipProvider>
      <div
        className={cn("flex items-center gap-[8px] min-w-0", className)}
        data-testid="project-source"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={copyPath}
              aria-label={
                copied ? t("source.copied") : t("source.copy")
              }
              data-testid="project-source-copy-path"
              className="group flex items-center gap-[6px] min-w-0 max-w-[280px] h-[24px] px-[8px] rounded-[7px] border border-border/70 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <span
                className="font-mono text-[11px] truncate"
                data-testid="project-source-path"
              >
                {gitRepoPath}
              </span>
              {copied ? (
                <Check
                  className="w-[12px] h-[12px] shrink-0 text-agent"
                  aria-hidden="true"
                />
              ) : (
                <Copy className="w-[12px] h-[12px] shrink-0" aria-hidden="true" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-mono text-[11px]">{gitRepoPath}</p>
            <p className="text-[11px] text-muted-foreground">
              {copied ? t("source.copiedShort") : t("source.clickToCopy")}
            </p>
          </TooltipContent>
        </Tooltip>

        {isManagedClone && (
          <Badge
            variant="outline"
            className="h-[22px] shrink-0 text-[10.5px] font-medium"
            data-testid="project-source-clone-badge"
          >
            {t("source.managedClone")}
          </Badge>
        )}

        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="project-source-remote-link"
            className="flex items-center gap-[4px] shrink-0 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="truncate max-w-[160px]">{linkLabel(sourceUrl)}</span>
            <ExternalLink className="w-[11px] h-[11px]" aria-hidden="true" />
          </a>
        )}
      </div>
    </TooltipProvider>
  );
}
