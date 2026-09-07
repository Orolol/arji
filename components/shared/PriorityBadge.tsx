"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PRIORITY_COLORS, PRIORITY_LABEL_KEYS } from "@/lib/types/kanban";

interface PriorityBadgeProps {
  priority: number;
  /** Extra classes; call sites keep their own sizing when they need it. */
  className?: string;
}

/**
 * Colored priority badge ("Medium" / "High" / "Critical").
 *
 * Low (0) is the default weight every ticket is created with, so rendering it
 * is pure noise on a dense board: below priority 1 the badge is nothing.
 */
export function PriorityBadge({ priority, className }: PriorityBadgeProps) {
  const tKey = useTranslations();
  if (!Number.isFinite(priority) || priority <= 0) return null;
  return (
    <Badge
      data-testid={`priority-badge-${priority}`}
      className={cn(
        "rounded-full border-0 px-[8px] py-0 text-[10.5px] font-medium leading-[16px]",
        PRIORITY_COLORS[priority] || PRIORITY_COLORS[1],
        className
      )}
    >
      {tKey(PRIORITY_LABEL_KEYS[priority] || PRIORITY_LABEL_KEYS[1])}
    </Badge>
  );
}
