import { GROUP_LABEL } from "@/lib/tickets-registry/aggregate";
import { PRIORITY_LABELS } from "@/lib/types/kanban";
import type { RegistryRow } from "@/lib/tickets-registry/types";

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

/** UTF-8 BOM, so Excel reads the accents instead of mojibake. */
const BOM = "\uFEFF";

/** Verbatim, accented, in the table's column order plus the row's project. */
const HEADER = [
  "Ticket",
  "Titre",
  "Projet",
  "État",
  "Groupe",
  "Stories",
  "Priorité",
  "Dernière activité",
  "Coût",
];

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
export function csvState(row: RegistryRow): string {
  switch (row.group) {
    case "active":
      return row.taskType ?? "active";
    case "your_turn":
      return row.yourTurnKind === "asks"
        ? "ASKS YOU"
        : row.yourTurnKind === "failed"
          ? "FAILED"
          : "CONFLICT";
    case "waiting":
      if (row.blockedBy.length > 0) return `waits on ${row.blockedBy[0]}`;
      if (row.isDraft) return "Draft";
      if (row.isQueued) return "QUEUED";
      if (row.queueRank !== null) return `${row.queueLabel ?? ""} · #${row.queueRank}`;
      return row.queueLabel ?? "";
    case "done":
      if (row.status === "to_merge" && row.mergeReady) return "Ready to land";
      if (row.status === "done") return "Merged";
      return row.mergeBlockerLine ?? "";
    case "released":
      return row.releaseVersion ?? "released";
  }
}

export function toCsv(rows: readonly RegistryRow[]): string {
  const lines = [HEADER.map(escapeField).join(",")];

  for (const row of rows) {
    const priority =
      row.priority === null ? "" : (PRIORITY_LABELS[row.priority] ?? String(row.priority));
    const fields = [
      row.readableId ?? row.epicId,
      row.title,
      row.projectName,
      csvState(row),
      GROUP_LABEL[row.group],
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
export function downloadCsv(rows: readonly RegistryRow[]): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = csvFilename();
  anchor.click();
  URL.revokeObjectURL(url);
}
