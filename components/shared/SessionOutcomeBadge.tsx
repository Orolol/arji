import { Badge } from "@/components/ui/badge";
import type { SessionOutcome } from "@/lib/agent-sessions/lifecycle";

/**
 * Visual config for each delivery verdict. Kept local (instead of importing
 * runtime values from the lifecycle module) so this stays a pure client
 * component with no server-only imports.
 */
const OUTCOME_CONFIG: Record<
  SessionOutcome,
  { label: string; className: string }
> = {
  answered: {
    label: "Answered",
    className: "text-agent border-agent-border bg-agent-bg",
  },
  asked_question: {
    label: "Asked a question",
    className:
      "text-priority-yellow border-priority-yellow/30 bg-priority-yellow/10",
  },
  silent: {
    label: "Silent",
    className: "text-meta border-border bg-band",
  },
  error: {
    label: "Error",
    className: "text-destructive border-destructive/30 bg-destructive/10",
  },
  transition_refused: {
    label: "Transition held",
    className:
      "text-priority-yellow border-priority-yellow/30 bg-priority-yellow/10",
  },
};

function isKnownOutcome(value: string): value is SessionOutcome {
  return value in OUTCOME_CONFIG;
}

/**
 * Delivery-verdict badge for an agent session. Renders nothing for
 * unclassified sessions (running, cancelled, legacy rows).
 */
export function SessionOutcomeBadge({
  outcome,
}: {
  outcome?: string | null;
}) {
  if (!outcome || !isKnownOutcome(outcome)) return null;

  const config = OUTCOME_CONFIG[outcome];
  return (
    <Badge
      variant="outline"
      className={`rounded-full px-[8px] py-[1px] text-[11px] font-normal ${config.className}`}
      data-testid={`session-outcome-${outcome}`}
    >
      {config.label}
    </Badge>
  );
}
