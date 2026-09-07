"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { GitMerge, RefreshCw } from "lucide-react";

import { BandHeader, Mono, PillButton, StrataBand } from "@/components/piscine";
import { PrBadge } from "@/components/github/PrBadge";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import { useGitStatus } from "@/hooks/useGitStatus";
import { useWorktrees } from "@/hooks/useWorktrees";
import { formatRelative } from "@/lib/i18n/format";

/**
 * Repository state, on Git Sync.
 *
 * This is `components/layout/RepoStatusBar` — the pre-redesign `bg-sidebar`
 * footer that used to hang under the project board — rebuilt as a stratum.
 * Its content had no other home: ahead/behind against the project's STORED
 * default branch (not whatever branch is checked out), the worktree count, the
 * open-PR pills, and the fetch/push pair.
 *
 * MISSING CONFIGURATION IS NOT AN ERROR. The old bar returned null when the
 * project had no local repository, which on a dedicated Git page reads as a
 * broken screen. It now names the missing piece instead — and the PAT gates
 * only the PR pills, exactly as before: ahead/behind, worktrees, fetch and
 * push are plain local git and must not vanish with the token.
 */

type PrStatus = "draft" | "open" | "closed" | "merged";

interface OpenPr {
  id: string;
  number: number;
  url: string;
  status: string;
}

export interface RepoStrataBandProps {
  projectId: string;
  /** From the project record; may be null. */
  ownerRepo: string | null;
  /** Local repository path from the project record; may be null. */
  gitRepoPath: string | null;
  /** Stored default branch, captured at GitHub import. "main" is the legacy
   *  fallback for rows that predate the column. */
  defaultBranch?: string | null;
}

export function RepoStrataBand({
  projectId,
  ownerRepo,
  gitRepoPath,
  defaultBranch,
}: RepoStrataBandProps) {
  const locale = useLocale();
  const t = useTranslations("Github");
  const config = useGitHubConfig(projectId);
  const repo = ownerRepo ?? config.ownerRepo;
  const enabled = Boolean(gitRepoPath);
  const prsEnabled = enabled && config.isConfigured;
  const branch = defaultBranch || "main";

  const { ahead, behind, lastFetchedAt, loading, error, refresh, push, pushing } =
    useGitStatus(projectId, branch, enabled);

  // Count only — the list and the cleanup action are the panel beside this
  // band. Null while unknown: a "0 worktrees" we cannot vouch for would be
  // worse than no counter.
  const { count: worktreeCount, refresh: refreshWorktrees } = useWorktrees(
    projectId,
    enabled,
  );

  const [prs, setPrs] = useState<OpenPr[]>([]);
  /** Bumped by Fetch to re-run the PR read; see the effect below. */
  const [prsReloads, setPrsReloads] = useState(0);

  // The write happens in the async continuation behind a cancel guard rather
  // than in the effect body, so an unmount mid-flight cannot set state and
  // `react-hooks/set-state-in-effect` stays satisfied without a suppression.
  useEffect(() => {
    if (!prsEnabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/prs`);
        const json = await res.json();
        if (!cancelled && Array.isArray(json?.data)) setPrs(json.data as OpenPr[]);
      } catch {
        // ignore — pills are informational
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, prsEnabled, prsReloads]);

  /* ---- no local repository: name what is missing ------------------- */

  if (!enabled) {
    return (
      <StrataBand stratum="feed" density="full" gap={8}>
        <BandHeader
          label={t("repo.label")}
          stratum="feed"
          meta={t("repo.notConnected")}
        />
        <p
          data-testid="repo-not-configured"
          className="font-sans text-[13px] leading-[1.55] text-muted-foreground"
        >
          {t("repo.noRepository")}
        </p>
      </StrataBand>
    );
  }

  const fetchedLabel = lastFetchedAt
    ? t("repo.fetched", { age: formatRelative(lastFetchedAt, { locale }) })
    : t("repo.neverFetched");

  return (
    <StrataBand stratum="feed" density="full" gap={10}>
      <BandHeader
        label={t("repo.label")}
        stratum="feed"
        meta={
          repo ?? gitRepoPath?.split("/").filter(Boolean).pop() ?? t("repo.localRepo")
        }
        right={
          <div className="flex items-center gap-2">
            <PillButton
              variant="outline"
              outlineTone="neutral"
              size="sm"
              icon={RefreshCw}
              data-testid="repo-fetch-button"
              disabled={loading}
              onClick={() => {
                refresh();
                setPrsReloads((n) => n + 1);
                void refreshWorktrees();
              }}
            >
              {t("repo.fetch")}
            </PillButton>
            <PillButton
              variant="filled"
              size="sm"
              icon={GitMerge}
              data-testid="repo-push-button"
              disabled={pushing || ahead === 0}
              onClick={() => void push()}
            >
              {t("repo.push", { branch })}
            </PillButton>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-2">
        {error ? (
          // The hook resolves ahead/behind against the stored default branch;
          // when it cannot (branch missing locally, git unreadable) it says
          // why, rather than showing a stale zero-count.
          <span data-testid="repo-status-error" className="min-w-0">
            <Mono size={11.5} tone="danger" clamp={1}>
              {error}
            </Mono>
          </span>
        ) : (
          <>
            <Mono size={11.5} tone="muted">{`${branch} · ${fetchedLabel}`}</Mono>
            <span data-testid="repo-ahead">
              {/* The arrow is frame furniture and stays inline; only the
                  words resolve from the catalogue. */}
              <Mono size={11.5} tone="feed-deep">{`↑ ${t("repo.ahead", { count: ahead })}`}</Mono>
            </span>
            <span data-testid="repo-behind">
              <Mono size={11.5} tone="feed-deep">{`↓ ${t("repo.behind", { count: behind })}`}</Mono>
            </span>
            {worktreeCount !== null ? (
              <span data-testid="repo-worktrees">
                <Mono size={11.5} tone="muted">
                  {t("repo.worktrees", { count: worktreeCount })}
                </Mono>
              </span>
            ) : null}
          </>
        )}

        {prs.length > 0 ? (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden">
            {prs.map((pr) => (
              <PrBadge
                key={pr.id}
                status={pr.status as PrStatus}
                number={pr.number}
                url={pr.url}
              />
            ))}
          </div>
        ) : null}
      </div>
    </StrataBand>
  );
}
