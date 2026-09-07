import { PRIORITY_LABEL_KEYS } from "@/lib/types/kanban";
import { catalogueValue } from "@/lib/i18n/catalogue";
/**
 * The registry's CSV export.
 *
 * The formula-injection guard is the one that matters most: ticket titles are
 * agent-written, and a title beginning `=` must not execute when the file is
 * opened in a spreadsheet.
 */
import { describe, it, expect } from "vitest";

import { csvFilename, csvState, toCsv, type CsvCopy } from "@/components/tickets-registry/csv";
import { translatorFor } from "@/lib/i18n/translator";
import type { RegistryRow } from "@/lib/tickets-registry/types";

/**
 * The phrases `useCsvCopy` resolves in the browser, built here from the real
 * catalogue so the file this suite inspects is the file the user downloads.
 */
const t = translatorFor("en", "Registry");
const copy: CsvCopy = {
  priority: Object.fromEntries(Object.entries(PRIORITY_LABEL_KEYS).map(([value, key]) => [value, catalogueValue("en", key)])),
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
};

function row(overrides: Partial<RegistryRow> & { epicId: string }): RegistryRow {
  return {
    projectId: "p1",
    readableId: "ARJ-122",
    title: "Streaming session logs over SSE",
    status: "todo",
    type: "feature",
    priority: 2,
    group: "waiting",
    taskType: null,
    startedAt: null,
    yourTurnKind: null,
    queueLabel: "To Do",
    queueRank: 1,
    blockedBy: [],
    isDraft: false,
    isQueued: false,
    mergeReady: false,
    mergeBlockerLine: null,
    releaseVersion: null,
    usDone: 2,
    usCount: 5,
    activity: "updated · 1d ago",
    activityAt: null,
    activityTone: "muted",
    costUsd: 0.84,
    projectName: "Arij",
    ...overrides,
  };
}

describe("toCsv", () => {
  it("opens with a BOM and the table's own header, and uses CRLF endings", () => {
    const csv = toCsv([row({ epicId: "1" })], copy);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.slice(1).split("\r\n")[0]).toBe(
      "Ticket,Title,Project,State,Group,Stories,Priority,Last activity,Cost",
    );
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.includes("\n\n")).toBe(false);
  });

  it("round-trips a title containing a comma, a quote and a newline", () => {
    const csv = toCsv([
      row({ epicId: "1", title: 'Fix "SSE", then\nship it' }),
    ], copy);
    expect(csv).toContain('"Fix ""SSE"", then\nship it"');
  });

  it("neutralises a title that would be read as a formula", () => {
    for (const lead of ["=", "+", "-", "@"]) {
      const csv = toCsv([row({ epicId: "1", title: `${lead}cmd|'/c calc'!A1` })], copy);
      expect(csv).toContain(`'${lead}cmd`);
    }
  });

  it("writes an EMPTY field for a null cost — never a zero", () => {
    const csv = toCsv([row({ epicId: "1", costUsd: null, usCount: 0, usDone: 0 })], copy);
    const line = csv.slice(1).split("\r\n")[1];
    const fields = line.split(",");
    // Stories and Cost are both empty; no "0" and no "0/0" anywhere.
    expect(line.endsWith(",")).toBe(true);
    expect(fields).not.toContain("0");
    expect(fields).not.toContain("0/0");
  });

  it("writes the raw number so the Cost column sums", () => {
    const csv = toCsv([row({ epicId: "1", costUsd: 0.84 })], copy);
    expect(csv).toContain(",0.84");
    expect(csv).not.toContain("$0.84");
  });

  it("exports rows a group's truncation hides", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row({ epicId: `e${index}`, group: "released", status: "released" }),
    );
    const csv = toCsv(rows, copy);
    expect(csv.slice(1).trimEnd().split("\r\n")).toHaveLength(13);
  });
});

describe("csvState", () => {
  it("flattens each group's ÉTAT cell to one phrase", () => {
    expect(csvState(row({ epicId: "1", group: "active", taskType: "BUILD" }), copy)).toBe(
      "BUILD",
    );
    expect(
      csvState(row({ epicId: "1", group: "your_turn", yourTurnKind: "asks" }), copy),
    ).toBe("ASKS YOU");
    expect(
      csvState(row({ epicId: "1", group: "your_turn", yourTurnKind: "failed" }), copy),
    ).toBe("FAILED");
    expect(csvState(row({ epicId: "1", group: "waiting" }), copy)).toBe("To Do · #1");
    expect(
      csvState(row({ epicId: "1", group: "waiting", blockedBy: ["ARJ-128"] }), copy),
    ).toBe("waits on ARJ-128");
    expect(
      csvState(
        row({ epicId: "1", group: "done", status: "to_merge", mergeReady: true }),
        copy,
      ),
    ).toBe("Ready to land");
    expect(csvState(row({ epicId: "1", group: "done", status: "done" }), copy)).toBe("Merged");
    expect(
      csvState(row({ epicId: "1", group: "released", releaseVersion: "v0.4.2" }), copy),
    ).toBe("v0.4.2");
    expect(csvState(row({ epicId: "1", group: "released" }), copy)).toBe("released");
  });
});

describe("csvFilename", () => {
  it("is dated", () => {
    expect(csvFilename(new Date("2026-08-30T12:00:00.000Z"))).toBe(
      "arij-tickets-2026-08-30.csv",
    );
  });
});
