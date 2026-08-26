"use client";

import {
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  XCircle,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { GradingStatus } from "@/lib/grading/report";

const STATUS_UI = {
  met: {
    label: "Met",
    icon: CheckCircle2,
    className:
      "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  partial: {
    label: "Partial",
    icon: CircleDashed,
    className:
      "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  missed: {
    label: "Missed",
    icon: XCircle,
    className: "border-destructive/35 bg-destructive/10 text-destructive",
  },
} as const;

interface GradingStatusBadgeProps {
  status: GradingStatus | null;
  evidence?: string | null;
  /** Optional card-oriented label such as "Criteria met". */
  label?: string;
  className?: string;
  testId?: string;
}

export function GradingStatusBadge({
  status,
  evidence,
  label,
  className,
  testId,
}: GradingStatusBadgeProps) {
  const config = status
    ? STATUS_UI[status]
    : {
        label: "Not graded",
        icon: CircleHelp,
        className: "border-border bg-band text-muted-foreground",
      };
  const Icon = config.icon;
  const badge = (
    <span
      className={cn(
        "inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full border px-[7px] text-[10.5px] font-medium leading-none",
        config.className,
        className,
      )}
      aria-label={label ?? config.label}
      data-testid={testId}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label ?? config.label}
    </span>
  );

  if (!evidence) return badge;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-[360px] text-xs leading-relaxed">
          {evidence}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
