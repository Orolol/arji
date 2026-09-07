import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { SessionOutcome } from "@/lib/agent-sessions/lifecycle";
import type { TranslationKey } from "@/lib/i18n/catalogue";

/**
 * Visual config for each delivery verdict. Kept local (instead of importing
 * runtime values from the lifecycle module) so this stays a pure client
 * component with no server-only imports.
 *
 * A module-scope copy table, so it holds catalogue KEY REFERENCES resolved at
 * render with the namespace-less translator (`lib/i18n/catalogue.ts`, pattern
 * 3). The words are `SessionLive.outcome.*` rather than a second copy of the
 * same five verdicts: `components/session-live/labels.ts` already names them,
 * and one vocabulary is the point.
 */
const OUTCOME_CONFIG: Record<
  SessionOutcome,
  { labelKey: TranslationKey; className: string }
> = {
  answered: {
    labelKey: "SessionLive.outcome.answered",
    className: "text-agent border-agent-border bg-agent-bg",
  },
  asked_question: {
    labelKey: "SessionLive.outcome.askedQuestion",
    className:
      "text-priority-yellow border-priority-yellow/30 bg-priority-yellow/10",
  },
  silent: {
    labelKey: "SessionLive.outcome.silent",
    className: "text-meta border-border bg-band",
  },
  error: {
    labelKey: "SessionLive.outcome.error",
    className: "text-destructive border-destructive/30 bg-destructive/10",
  },
  transition_refused: {
    labelKey: "SessionLive.outcome.transitionRefused",
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
  // The table above holds full dotted paths, so it resolves through the
  // namespace-less translator.
  const t = useTranslations();
  if (!outcome || !isKnownOutcome(outcome)) return null;

  const config = OUTCOME_CONFIG[outcome];
  return (
    <Badge
      variant="outline"
      className={`rounded-full px-[8px] py-[1px] text-[11px] font-normal ${config.className}`}
      data-testid={`session-outcome-${outcome}`}
    >
      {t(config.labelKey)}
    </Badge>
  );
}
