"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { COLUMN_LABEL_KEYS, PRIORITY_LABEL_KEYS } from "@/lib/types/kanban";

/** Resolved phrases for the pure ticket timeline and metadata derivations. */
export interface TicketDerivedCopy {
  columns: Record<string, string>;
  priorities: Record<number, string>;
  actors: Record<string, string>;
  transitions: (count: number) => string;
  pipelineEvent: string;
  bugCreated: string;
  bugDetail: (detail: string) => string;
  priority: (priority: string) => string;
  created: (age: string) => string;
  github: (number: number) => string;
}

export function useTicketDerivedCopy(): TicketDerivedCopy {
  const t = useTranslations();
  return useMemo(() => ({
    columns: Object.fromEntries(Object.entries(COLUMN_LABEL_KEYS).map(([status, key]) => [status, t(key)])),
    priorities: Object.fromEntries(Object.entries(PRIORITY_LABEL_KEYS).map(([priority, key]) => [priority, t(key)])),
    actors: { user: t("Ticket.derived.actors.user"), agent: t("Ticket.derived.actors.agent"), system: t("Ticket.derived.actors.system") },
    transitions: (count) => t("Ticket.derived.transitions", { count }),
    pipelineEvent: t("Ticket.derived.pipelineEvent"),
    bugCreated: t("Ticket.derived.bugCreated"),
    bugDetail: (detail) => t("Ticket.derived.bugDetail", { detail }),
    priority: (priority) => t("Ticket.derived.priority", { priority }),
    created: (age) => t("Ticket.derived.created", { age }),
    github: (number) => t("Ticket.derived.github", { number }),
  }), [t]);
}
