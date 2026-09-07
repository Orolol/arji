"use client";

import {
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import { useTranslations } from "next-intl";

import type { TranslationKey } from "@/lib/i18n/catalogue";
import { cn } from "@/lib/utils";

type PrStatus = "draft" | "open" | "closed" | "merged";

interface PrBadgeProps {
  status: PrStatus;
  number?: number;
  url?: string;
}

/**
 * Token-only pill styling (cassette pêche): agent teal for the live PR,
 * meta for drafts, destructive for closed, coral for merged. No raw hex and
 * no Tailwind palette colors — every value resolves through a CSS variable.
 */
const STATUS_STYLES: Record<PrStatus, string> = {
  draft: "bg-card border-border text-meta",
  open: "bg-agent-bg border-agent-border text-agent",
  closed: "bg-card border-destructive/40 text-destructive",
  merged: "bg-card border-primary/40 text-primary",
};

/**
 * A MODULE-SCOPE COPY TABLE, so it holds catalogue KEY REFERENCES and the
 * badge resolves them at render with the namespace-less translator
 * (`lib/i18n/catalogue.ts`, pattern 3).
 */
const STATUS_LABELS: Record<PrStatus, { labelKey: TranslationKey }> = {
  draft: { labelKey: "Github.pr.draft" },
  open: { labelKey: "Github.pr.open" },
  closed: { labelKey: "Github.pr.closed" },
  merged: { labelKey: "Github.pr.merged" },
};

/**
 * One icon per lifecycle state, so a pill is readable at a glance in the
 * repo footer. The mockup's checks-OK / review-requested / merge-conflict
 * icons are deliberately absent: check runs and review state are not stored,
 * and the footer must not block on a GitHub round-trip to invent them.
 */
const STATUS_ICONS: Record<PrStatus, typeof GitPullRequestArrow> = {
  draft: GitPullRequestDraft,
  open: GitPullRequestArrow,
  closed: GitPullRequestClosed,
  merged: GitMerge,
};

export function PrBadge({ status, number, url }: PrBadgeProps) {
  const t = useTranslations();
  const Icon = STATUS_ICONS[status];
  const content = (
    <span
      data-testid={`pr-badge-${status}`}
      className={cn(
        "inline-flex items-center gap-[6px] h-[26px] px-[10px] rounded-full border text-[12px] font-medium",
        STATUS_STYLES[status]
      )}
    >
      <Icon
        className="w-[13px] h-[13px] shrink-0"
        data-testid={`pr-badge-icon-${status}`}
        aria-hidden="true"
      />
      {number ? (
        <span className="font-mono text-[11.5px]">{`#${number}`}</span>
      ) : null}
      <span>{t(STATUS_LABELS[status].labelKey)}</span>
    </span>
  );

  if (url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex hover:opacity-80 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </a>
    );
  }

  return content;
}
