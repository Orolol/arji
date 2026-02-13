"use client";

import { Badge } from "@/components/ui/badge";
import { GitPullRequest } from "lucide-react";

type PrStatus = "draft" | "open" | "closed" | "merged";

interface PrBadgeProps {
  status: PrStatus;
  number?: number;
  url?: string;
}

const STATUS_STYLES: Record<PrStatus, string> = {
  draft: "bg-yellow-500/15 text-yellow-500 border-yellow-500/30",
  open: "bg-green-500/15 text-green-500 border-green-500/30",
  closed: "bg-red-500/15 text-red-500 border-red-500/30",
  merged: "bg-purple-500/15 text-purple-500 border-purple-500/30",
};

const STATUS_LABELS: Record<PrStatus, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};

export function PrBadge({ status, number, url }: PrBadgeProps) {
  const content = (
    <Badge
      variant="outline"
      className={`gap-1 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      <GitPullRequest className="h-3 w-3" />
      {number ? `#${number}` : ""} {STATUS_LABELS[status]}
    </Badge>
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
