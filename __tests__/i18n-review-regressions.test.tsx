// Exercise actual next-intl context: changing catalogue values must reach the
// UI even when copy originated in a lib/ table rather than a JSX literal.
import type { ReactNode } from "react";
import { cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { messagesFor } from "@/lib/i18n/catalogue";
import { COLUMN_LABEL_KEYS, PRIORITY_LABEL_KEYS } from "@/lib/types/kanban";
import { PIPELINE_STAGE_LABEL_KEYS } from "@/lib/pipeline/constants";
import { ticketStatusOptions } from "@/lib/kanban/status-transitions";
import { createEmptyEpicDraft, validateManualEpicDraft, EPIC_TITLE_MAX_LENGTH } from "@/lib/epics/manual-epic-form";
import { EditorFooterBar } from "@/components/agents-workshop/EditorFooterBar";
import { PriorityBadge } from "@/components/shared/PriorityBadge";
import { StatusControl } from "@/components/ticket/StatusControl";
import { useTicketDerivedCopy } from "@/components/ticket/copy";
import { descriptionMeta } from "@/components/ticket/derive";
import { useCsvCopy } from "@/components/tickets-registry/csv";
import { pipelineChipLabel } from "@/hooks/usePipelineRuns";

vi.unmock("next-intl");
afterEach(cleanup);

const messages = structuredClone(messagesFor("en"));
messages.Kanban.columns.todo = "À faire";
messages.Kanban.priorities.high = "Haute";
messages.Kanban.transitionReasons.noDirect = "Aucun passage depuis {status}";
messages.Kanban.validation.epicTitleTooLong = "Maximum {max} caractères";
messages.Kanban.pipelineStages.review = "Relecture";
messages.Kanban.pipelineChipStage = "Circuit · {stage}";
messages.Ticket.derived.priority = "priorité {priority}";
const t = createTranslator({ locale: "fr", messages });
function Wrapper({ children }: { children: ReactNode }) {
  return <NextIntlClientProvider locale="fr" messages={messages}>{children}</NextIntlClientProvider>;
}

describe("lib copy resolves at the rendering boundary", () => {
  it("keeps the agent editor footer in month/year bands", () => {
    render(<NextIntlClientProvider locale="en" messages={messagesFor("en")}>
      <EditorFooterBar agentName="Fixture" createdAt={new Date(Date.now() - 425 * 86400000).toISOString()} dirty={false} saving={false} deleting={false} canSave={false} error={null} onSave={() => {}} onDiscard={() => {}} onDelete={async () => {}} />
    </NextIntlClientProvider>);
    expect(screen.getByText("created 1y ago")).toBeVisible();
  });
  it("keeps all shared status, priority and stage tables as catalogue references", () => {
    for (const key of [...Object.values(COLUMN_LABEL_KEYS), ...Object.values(PRIORITY_LABEL_KEYS), ...Object.values(PIPELINE_STAGE_LABEL_KEYS)]) {
      expect(key).toMatch(/^Kanban\./);
      expect(t.has(key)).toBe(true);
    }
  });

  it("renders translated priority badges and the ticket's current status", () => {
    render(<><PriorityBadge priority={2} /><StatusControl status="todo" priority={2} hasRunningSession={false} onStatusChange={() => {}} onPriorityChange={() => {}} /></>, { wrapper: Wrapper });
    expect(screen.getByText("Haute")).toBeVisible();
    expect(screen.getByText("À faire")).toBeVisible();
  });

  it("resolves transition reasons and their nested status through the catalogue", () => {
    const option = ticketStatusOptions("todo").find((entry) => entry.status === "review")!;
    expect(t(option.disabledReasonKey!, { status: t(COLUMN_LABEL_KEYS.todo) })).toBe("Aucun passage depuis À faire");
  });

  it("keeps client validation limits interpolatable without changing validation", () => {
    const result = validateManualEpicDraft({ ...createEmptyEpicDraft(), title: "x".repeat(EPIC_TITLE_MAX_LENGTH + 1) });
    expect(result.valid).toBe(false);
    expect(t(result.titleError!, { max: EPIC_TITLE_MAX_LENGTH })).toBe("Maximum 200 caractères");
  });

  it("shares translated priorities with metadata and CSV, without importing a catalogue into their helpers", () => {
    const { result } = renderHook(() => ({ ticket: useTicketDerivedCopy(), csv: useCsvCopy() }), { wrapper: Wrapper });
    expect(descriptionMeta({ priority: 2 }, "fr", result.current.ticket)).toBe("priorité haute");
    expect(result.current.csv.priority[2]).toBe("Haute");
    expect(result.current.ticket.columns.todo).toBe("À faire");
  });

  it("composes pipeline chips from caller-resolved phrases", () => {
    const copy = { pipeline: t("Kanban.pipelineChip"), stage: (stage: keyof typeof PIPELINE_STAGE_LABEL_KEYS) => t("Kanban.pipelineChipStage", { stage: t(PIPELINE_STAGE_LABEL_KEYS[stage]) }) };
    expect(pipelineChipLabel({ runId: "run", stage: "review", active: true }, copy)).toBe("Circuit · Relecture");
    expect(pipelineChipLabel({ runId: "run", stage: null, active: false }, copy)).toBe("Pipeline");
  });
});
