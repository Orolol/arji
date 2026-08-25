"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Bug } from "lucide-react";

interface TicketTypeBadgeProps {
  /** Ticket type — renders nothing unless it is "bug". */
  type: string;
  /** Badge classes. Call sites keep their original class strings. */
  className?: string;
  /** Bug icon classes. Call sites keep their original class strings. */
  iconClassName?: string;
  /**
   * "badge" (default) is the pill used by the ticket panel. "meta" is the
   * board card's inline form: a bare mono `BUG` token that lives inside the
   * card's metadata line instead of adding a badge row of its own.
   */
  variant?: "badge" | "meta";
}

/** Red "Bug" marker shown on bug-type tickets (kanban card + epic detail). */
export function TicketTypeBadge({
  type,
  className,
  iconClassName = "h-3 w-3 mr-0.5",
  variant = "badge",
}: TicketTypeBadgeProps) {
  if (type !== "bug") return null;

  if (variant === "meta") {
    return <span className={cn("text-destructive", className)}>BUG</span>;
  }

  return (
    <Badge
      data-testid="ticket-type-badge"
      className={cn(
        "border-0 bg-destructive/10 text-xs text-destructive",
        className
      )}
    >
      <Bug className={iconClassName} />
      Bug
    </Badge>
  );
}
