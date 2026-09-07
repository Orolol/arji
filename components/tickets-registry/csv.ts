"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";

import { PRIORITY_LABEL_KEYS } from "@/lib/types/kanban";
import type { RegistryGroup, RegistryRow } from "@/lib/tickets-registry/types";

/**
 * The registry's CSV export.
 *
 * Client-side is correct here: this is the real app, not a sandboxed artifact,
 * and every row is already in memory. A route would re-run the whole scan to
 * produce bytes the browser already holds.
 *
 * It exports the currently FILTERED rows across all groups, ignoring group
 * truncation — truncation is a display device, not a scope. It cannot export
 * past the loaded window, which is why the link says how many rows it covers.
 */

/** RFC 4180 line ending. */
const CRLF = "\r\n";

/**
 * UTF-8 BOM, so Excel reads accented characters instead of mojibake. Still
 * load-bearing with an English header: ticket titles and project names are
 * user and agent data, in whatever language they were written.
 */
const BOM = "\uFEFF";

/**
 * Everything the export writes that is COPY, already resolved.
 *
 * LOCALIZED, NOT PINNED — the judgement this file had to make. These headers
 * are the SCREEN's column headers saved to disk: the file has no machine
 * consumer, nothing reads it back, the name is a dated one-off
 * (`arij-tickets-2026-08-30.csv`), and the BOM above exists precisely so a
 * person's spreadsheet renders the words. A header row pinned to English
 * while the table it mirrors was translated would split one deliberate mirror
 * in two. So the export shares `Registry.columns.*` with
 * `components/tickets-registry/RegistryTable.tsx` and adds only the two
 * columns the table has no room for (project, group).
 *
 * RESOLVED PHRASES, not a translator: `toCsv` and `csvState` stay pure — the
 * suite drives them directly — and every key literal stays next to the
 * `useTranslations` binding in `useCsvCopy` below (`lib/i18n/catalogue.ts`).
 */
export interface CsvCopy {
  priority: Record<number, string>;
  /** The nine header cells, in the order `toCsv` writes them. */
  headers: readonly string[];
  /** The GROUPE column: the same five words the group headers print. */
  group: Record<RegistryGroup, string>;
  /** The ÉTAT column, the same vocabulary `RegistryRow.tsx` draws. */
  state: {
    active: string;
    asks: string;
    failed: string;
    conflict: string;
    draft: string;
    queued: string;
    readyToLand: string;
    merged: string;
    released: string;
    waitsOn: (blocker: string) => string;
    queueRank: (label: string, rank: number) => string;
  };
}

/**
 * The export's copy, resolved once per render of the screen that offers it.
 *
 * It lives here rather than in the view so the CSV's vocabulary stays with
 * the CSV, and so the keys sit beside their `useTranslations` binding.
 */
export function useCsvCopy(): CsvCopy {
  const t = useTranslations("Registry");
  const tKey = useTranslations();
  return useMemo(
    () => ({
      priority: Object.fromEntries(Object.entries(PRIORITY_LABEL_KEYS).map(([value, key]) => [value, tKey(key)])),
      headers: [
        t("columns.ticket"),
        t("columns.title"),
        t("columns.project"),
        t("columns.state"),
        t("columns.group"),
        t("columns.stories"),
        t("columns.priority"),
        t("columns.activity"),
        t("columns.cost"),
      ],
      group: {
        active: t("groups.active"),
        your_turn: t("groups.yourTurn"),
        waiting: t("groups.waiting"),
        done: t("groups.done"),
        released: t("groups.released"),
      },
      state: {
        active: t("state.active"),
        asks: t("state.asks"),
        failed: t("state.failed"),
        conflict: t("state.conflict"),
        draft: t("state.draft"),
        queued: t("state.queued"),
        readyToLand: t("state.readyToLand"),
        merged: t("state.merged"),
        released: t("state.released"),
        waitsOn: (blocker) => t("state.waitsOn", { blocker }),
        queueRank: (label, rank) => t("state.queueRank", { label, rank }),
      },
    }),
    [t, tKey],
  );
}

/**
 * Characters that make a spreadsheet treat a cell as a FORMULA.
 *
 * An agent-written ticket title beginning `=` must not execute when the file is
 * opened; prefixing a single quote is the standard neutralisation and survives
 * a round-trip as visible text.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

function escapeField(value: string): string {
  const guarded = FORMULA_LEAD.has(value.charAt(0)) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** The ÉTAT column, flattened to the one phrase the row's cell shows. */
export function csvState(row: RegistryRow, copy: CsvCopy): string {
  const state = copy.state;
  switch (row.group) {
    case "active":
      // The raw dispatch role, exactly as the payload carries it — a machine
      // token, not the row's `TASK_LABEL` word.
      return row.taskType ?? state.active;
    case "your_turn":
      return row.yourTurnKind === "asks"
        ? state.asks
        : row.yourTurnKind === "failed"
          ? state.failed
          : state.conflict;
    case "waiting":
      if (row.blockedBy.length > 0) return state.waitsOn(row.blockedBy[0]);
      if (row.isDraft) return state.draft;
      if (row.isQueued) return state.queued;
      if (row.queueRank !== null) {
        return state.queueRank(row.queueLabel ?? "", row.queueRank);
      }
      return row.queueLabel ?? "";
    case "done":
      if (row.status === "to_merge" && row.mergeReady) return state.readyToLand;
      if (row.status === "done") return state.merged;
      return row.mergeBlockerLine ?? "";
    case "released":
      return row.releaseVersion ?? state.released;
  }
}

export function toCsv(rows: readonly RegistryRow[], copy: CsvCopy): string {
  const lines = [copy.headers.map(escapeField).join(",")];

  for (const row of rows) {
    const priority =
      row.priority === null ? "" : (copy.priority[row.priority] ?? String(row.priority));
    const fields = [
      row.readableId ?? row.epicId,
      row.title,
      row.projectName,
      csvState(row, copy),
      copy.group[row.group],
      // Never "0/0": a ticket with no stories has no fraction to report.
      row.usCount > 0 ? `${row.usDone}/${row.usCount}` : "",
      priority,
      row.activity ?? "",
      // The raw number so the column sums; `null` is an EMPTY field, never 0.
      row.costUsd === null ? "" : String(row.costUsd),
    ];
    lines.push(fields.map(escapeField).join(","));
  }

  return BOM + lines.join(CRLF) + CRLF;
}

/** `arij-tickets-2026-08-30.csv` */
export function csvFilename(now: Date = new Date()): string {
  return `arij-tickets-${now.toISOString().slice(0, 10)}.csv`;
}

/** Hand the browser the file. No-op outside a DOM. */
export function downloadCsv(rows: readonly RegistryRow[], copy: CsvCopy): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const blob = new Blob([toCsv(rows, copy)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = csvFilename();
  anchor.click();
  URL.revokeObjectURL(url);
}
