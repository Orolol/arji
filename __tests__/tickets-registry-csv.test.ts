/**
 * The registry's CSV export.
 *
 * The formula-injection guard is the one that matters most: ticket titles are
 * agent-written, and a title beginning `=` must not execute when the file is
 * opened in a spreadsheet.
 */
import { describe, it, expect } from "vitest";

import { csvFilename, csvState, toCsv } from "@/components/tickets-registry/csv";
import type { RegistryRow } from "@/lib/tickets-registry/types";

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
    activityTone: "muted",
    costUsd: 0.84,
    projectName: "Arij",
    ...overrides,
  };
}

describe("toCsv", () => {
  it("opens with a BOM and an accented header, and uses CRLF endings", () => {
    const csv = toCsv([row({ epicId: "1" })]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.slice(1).split("\r\n")[0]).toBe(
      "Ticket,Titre,Projet,État,Groupe,Stories,Priorité,Dernière activité,Coût",
    );
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.includes("\n\n")).toBe(false);
  });

  it("round-trips a title containing a comma, a quote and a newline", () => {
    const csv = toCsv([
      row({ epicId: "1", title: 'Fix "SSE", then\nship it' }),
    ]);
    expect(csv).toContain('"Fix ""SSE"", then\nship it"');
  });

  it("neutralises a title that would be read as a formula", () => {
    for (const lead of ["=", "+", "-", "@"]) {
      const csv = toCsv([row({ epicId: "1", title: `${lead}cmd|'/c calc'!A1` })]);
      expect(csv).toContain(`'${lead}cmd`);
    }
  });

  it("writes an EMPTY field for a null cost — never a zero", () => {
    const csv = toCsv([row({ epicId: "1", costUsd: null, usCount: 0, usDone: 0 })]);
    const line = csv.slice(1).split("\r\n")[1];
    const fields = line.split(",");
    // Stories and Coût are both empty; no "0" and no "0/0" anywhere.
    expect(line.endsWith(",")).toBe(true);
    expect(fields).not.toContain("0");
    expect(fields).not.toContain("0/0");
  });

  it("writes the raw number so the Coût column sums", () => {
    const csv = toCsv([row({ epicId: "1", costUsd: 0.84 })]);
    expect(csv).toContain(",0.84");
    expect(csv).not.toContain("$0.84");
  });

  it("exports rows a group's truncation hides", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row({ epicId: `e${index}`, group: "released", status: "released" }),
    );
    const csv = toCsv(rows);
    expect(csv.slice(1).trimEnd().split("\r\n")).toHaveLength(13);
  });
});

describe("csvState", () => {
  it("flattens each group's ÉTAT cell to one phrase", () => {
    expect(csvState(row({ epicId: "1", group: "active", taskType: "BUILD" }))).toBe(
      "BUILD",
    );
    expect(
      csvState(row({ epicId: "1", group: "your_turn", yourTurnKind: "asks" })),
    ).toBe("ASKS YOU");
    expect(
      csvState(row({ epicId: "1", group: "your_turn", yourTurnKind: "failed" })),
    ).toBe("FAILED");
    expect(csvState(row({ epicId: "1", group: "waiting" }))).toBe("To Do · #1");
    expect(
      csvState(row({ epicId: "1", group: "waiting", blockedBy: ["ARJ-128"] })),
    ).toBe("waits on ARJ-128");
    expect(
      csvState(
        row({ epicId: "1", group: "done", status: "to_merge", mergeReady: true }),
      ),
    ).toBe("Ready to land");
    expect(csvState(row({ epicId: "1", group: "done", status: "done" }))).toBe("Merged");
    expect(
      csvState(row({ epicId: "1", group: "released", releaseVersion: "v0.4.2" })),
    ).toBe("v0.4.2");
    expect(csvState(row({ epicId: "1", group: "released" }))).toBe("released");
  });
});

describe("csvFilename", () => {
  it("is dated", () => {
    expect(csvFilename(new Date("2026-08-30T12:00:00.000Z"))).toBe(
      "arij-tickets-2026-08-30.csv",
    );
  });
});
