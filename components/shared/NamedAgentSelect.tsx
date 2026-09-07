"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNamedAgentsList } from "@/hooks/useNamedAgentsList";
import { useDispatchReliability } from "@/hooks/useDispatchReliability";
import {
  formatReliabilityBadge,
  type DispatchRole,
} from "@/lib/agent-config/dispatch-reliability-constants";

/**
 * Sentinel for the "no agent" row. Radix forbids an empty `SelectItem`
 * value, so the empty string only appears on the way out through
 * `onChange` — which is what the conversation PATCH route reads as
 * "clear the conversation-specific agent".
 */
const NO_AGENT_VALUE = "__none__";

interface NamedAgentSelectProps {
  value: string | null;
  onChange: (namedAgentId: string) => void;
  disabled?: boolean;
  className?: string;
  /**
   * Id placed on the trigger. The trigger renders a `<button>`, which is a
   * labelable element, so a caller holding a visible `<label>` can associate
   * it the plain HTML way (`htmlFor` → this id) instead of reaching for
   * `aria-labelledby`.
   */
  id?: string;
  /**
   * Accessible name for the trigger. A visible label sitting next to the
   * control is not programmatically associated with it unless the caller says
   * so, so screen readers otherwise announce it as an unlabeled combobox —
   * worth passing wherever several of these sit in one form.
   */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Id of the helper text describing the picker, if the caller renders one. */
  "aria-describedby"?: string;
  /**
   * Adds a "No agent" row so an already-attached agent can be detached.
   * Dispatch dialogs require an agent and leave this off; the chat header
   * turns it on, because a conversation whose agent cannot be cleared can
   * never switch provider (the provider select yields to a named agent).
   */
  allowClear?: boolean;
  /** Label of the clear row. */
  clearLabel?: string;
  /**
   * Task type this picker dispatches. When set, each agent row carries its
   * measured success rate and median duration FOR THAT ROLE over the last 30
   * days — an em-dash below the sample threshold, so a 2-run "100%" never
   * reads as a recommendation. Omitted, the picker renders plain names.
   */
  dispatchRole?: DispatchRole;
}

export function NamedAgentSelect({
  value,
  onChange,
  disabled = false,
  className,
  id,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "aria-describedby": ariaDescribedBy,
  allowClear = false,
  clearLabel = "No agent",
  dispatchRole,
}: NamedAgentSelectProps) {
  const { agents, loading } = useNamedAgentsList();
  const reliability = useDispatchReliability(dispatchRole);
  // Carried by every branch below: the loading and empty states render a
  // trigger too, and a picker that is only named once its agents arrive is
  // still an unlabeled combobox for the reader who reaches it first.
  const labelProps = {
    ...(id ? { id } : {}),
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
    ...(ariaLabelledBy ? { "aria-labelledby": ariaLabelledBy } : {}),
    ...(ariaDescribedBy ? { "aria-describedby": ariaDescribedBy } : {}),
  };

  if (loading) {
    return (
      <Select disabled>
        <SelectTrigger {...labelProps} className={className ?? "w-44 h-7 text-xs"}>
          <SelectValue placeholder="Loading..." />
        </SelectTrigger>
      </Select>
    );
  }

  if (agents.length === 0) {
    return (
      <Select disabled>
        <SelectTrigger {...labelProps} className={className ?? "w-44 h-7 text-xs"}>
          <SelectValue placeholder="No agents configured" />
        </SelectTrigger>
      </Select>
    );
  }

  return (
    <Select
      value={value ?? (allowClear ? NO_AGENT_VALUE : undefined)}
      onValueChange={(next) =>
        onChange(next === NO_AGENT_VALUE ? "" : next)
      }
      disabled={disabled}
    >
      <SelectTrigger {...labelProps} className={className ?? "w-44 h-7 text-xs"}>
        <SelectValue placeholder="Select agent" />
      </SelectTrigger>
      <SelectContent>
        {allowClear && (
          <SelectItem value={NO_AGENT_VALUE}>{clearLabel}</SelectItem>
        )}
        {agents.map((agent) => {
          const isComposite = agent.kind === "composite";
          // `?? []` for the same reason as in AgentSelectPill: the list is
          // fetched, and an older payload must degrade rather than crash.
          const members = agent.members ?? [];
          // A COMPOSITE'S LADDER, in the row's title. The list is what
          // predicts the run, and it is the whole difference between the two
          // kinds of row.
          const ladder = isComposite
            ? members.map((member) => member.name).join(" → ") ||
              "no members — unusable"
            : undefined;

          const kindMark = isComposite ? (
            <span
              data-testid={`agent-kind-${agent.id}`}
              className="shrink-0 font-mono text-[10px] uppercase tracking-[.06em] text-muted-foreground"
            >
              {members.length > 0
                ? `composite · ${members.length}`
                : "composite · empty"}
            </span>
          ) : null;

          // NO RELIABILITY BADGE ON A COMPOSITE, and none invented. The
          // aggregate groups by `agent_sessions.named_agent_id`, which records
          // the MEMBER that ran and never the composite that dispatched it, so
          // a composite has no row at all — a badge here would be a fabricated
          // em-dash presented as a measurement. It carries its member count
          // instead, which is a fact about it.
          if (!dispatchRole || isComposite) {
            return (
              <SelectItem key={agent.id} value={agent.id} title={ladder}>
                <span className="flex w-full min-w-0 items-center justify-between gap-3">
                  <span className="truncate">{agent.name}</span>
                  {kindMark}
                </span>
              </SelectItem>
            );
          }

          const badge = formatReliabilityBadge(
            reliability.byAgentId.get(agent.id),
            dispatchRole,
            reliability.minSample,
            reliability.windowDays
          );
          return (
            <SelectItem key={agent.id} value={agent.id}>
              <span className="flex w-full items-center justify-between gap-3">
                <span>{agent.name}</span>
                <span
                  data-testid={`agent-reliability-${agent.id}`}
                  title={badge.title}
                  className={
                    badge.hasSample
                      ? "shrink-0 tabular-nums text-[11px] text-muted-foreground"
                      : "shrink-0 tabular-nums text-[11px] text-meta"
                  }
                >
                  {reliability.loading ? "" : badge.label}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
