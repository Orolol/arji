/**
 * The pure half of frame 11b: severity stamps, verdict prose, coverage and the
 * rubric extraction. No database, no rendering — every rule this file pins is a
 * rule the route and the screen inherit rather than restate.
 */

import { describe, expect, it } from "vitest";

import {
  checkStatusLabel,
  checkTypeLabel,
  compareFindings,
  deriveChecks,
  deriveCoverage,
  deriveQueued,
  deriveRuns,
  deriveVerdicts,
  outcomeArrow,
  isCheckLive,
  rubricItemsFromChecklist,
  runLastLine,
  severityOf,
  sumCheckTotals,
  stripSeverityPrefix,
  type QaCheckRow,
  type QaSessionRow,
  type QaVerdictEpic,
  type QaVerdictSessionRow,
  type QaVerdictCopy,
} from "@/lib/qa/aggregate";
import { translatorFor } from "@/lib/i18n/translator";
import { REVIEW_CHECKLISTS } from "@/lib/claude/prompt-sections";
import type { QaRun } from "@/lib/qa/types";

describe("severityOf", () => {
  it("prints BLOCKING, never CRITICAL, for the top tier", () => {
    expect(severityOf("[critical] token logged in clear", "agent")).toEqual({
      severity: "critical",
      severityLabel: "BLOCKING",
      tier: "blocking",
    });
  });

  it("weighs [major] as the MAJOR stamp — which still blocks the merge", () => {
    expect(severityOf("[major] no test", "agent")).toEqual({
      severity: "major",
      severityLabel: "MAJOR",
      tier: "major",
    });
  });

  it("weighs [minor] and [info] as the light stamp", () => {
    expect(severityOf("[minor] naming", "agent").tier).toBe("minor");
    expect(severityOf("[minor] naming", "agent").severityLabel).toBe("MINOR");
    expect(severityOf("[info] fyi", "agent").tier).toBe("minor");
    expect(severityOf("[info] fyi", "agent").severityLabel).toBe("INFO");
  });

  it("is CASE-SENSITIVE: [MAJOR] is unclassified, deliberately", () => {
    expect(severityOf("[MAJOR] shouting", "agent")).toEqual({
      severity: "unclassified",
      severityLabel: "UNCLASSIFIED",
      tier: "blocking",
    });
  });

  it("treats an agent row with no recognised prefix as unclassified, and blocking", () => {
    expect(severityOf("just a worry", "agent").severityLabel).toBe("UNCLASSIFIED");
    expect(severityOf("just a worry", "agent").tier).toBe("blocking");
  });

  it("treats an empty or null body the same way", () => {
    expect(severityOf("", "agent").severity).toBe("unclassified");
    expect(severityOf(null, "agent").severity).toBe("unclassified");
  });

  it("marks any non-agent author HUMAN, which always blocks", () => {
    expect(severityOf("[minor] still a hold", "user")).toEqual({
      severity: "human",
      severityLabel: "HUMAN",
      tier: "blocking",
    });
    expect(severityOf("anything", null).severityLabel).toBe("HUMAN");
  });
});

describe("stripSeverityPrefix", () => {
  it("removes exactly one known prefix and its space", () => {
    expect(stripSeverityPrefix("[critical] boom")).toBe("boom");
    expect(stripSeverityPrefix("[minor] naming")).toBe("naming");
  });

  it("leaves an unknown bracket token untouched", () => {
    expect(stripSeverityPrefix("[foo] bar")).toBe("[foo] bar");
    expect(stripSeverityPrefix("[MAJOR] bar")).toBe("[MAJOR] bar");
  });

  it("strips only the first prefix", () => {
    expect(stripSeverityPrefix("[major] [major] twice")).toBe("[major] twice");
  });

  it("answers the empty string for a missing body", () => {
    expect(stripSeverityPrefix(null)).toBe("");
  });
});

describe("compareFindings", () => {
  it("orders heaviest stamp first, newest first inside a tier", () => {
    const rows = [
      { tier: "minor" as const, filedAt: "2026-08-30T10:00:00.000Z" },
      { tier: "major" as const, filedAt: "2026-08-30T08:00:00.000Z" },
      { tier: "major" as const, filedAt: "2026-08-30T09:00:00.000Z" },
      { tier: "blocking" as const, filedAt: "2026-08-30T07:00:00.000Z" },
    ];
    expect([...rows].sort(compareFindings).map((row) => row.tier)).toEqual([
      "blocking",
      "major",
      "major",
      "minor",
    ]);
    expect([...rows].sort(compareFindings)[1].filedAt).toBe(
      "2026-08-30T09:00:00.000Z",
    );
  });
});

/* ------------------------------------------------------------------ */

function session(overrides: Partial<QaSessionRow> = {}): QaSessionRow {
  return {
    id: "s1",
    projectId: "p1",
    epicId: "e1",
    status: "running",
    namedAgentName: "Security CC",
    agentType: "review_security",
    startedAt: "2026-08-30T09:00:00.000Z",
    createdAt: "2026-08-30T09:00:00.000Z",
    lastLine: "checking migration rollback",
    epicTitle: "Named agents: per-task defaults",
    epicReadableId: "ARJ-113",
    ...overrides,
  };
}

describe("deriveRuns / deriveQueued", () => {
  it("splits running from queued and never invents an agent name", () => {
    const rows = [
      session(),
      session({ id: "s2", status: "queued", epicReadableId: "ARJ-122" }),
      session({ id: "s3", namedAgentName: null, agentType: "review_code" }),
    ];
    const runs = deriveRuns(rows, new Map());
    expect(runs.map((run) => run.sessionId)).toEqual(["s1", "s3"]);
    expect(runs[1].agentName).toBe("review_code");
    expect(deriveQueued(rows).map((run) => run.sessionId)).toEqual(["s2"]);
  });

  it("carries the filing counts of a live reviewer", () => {
    const runs = deriveRuns(
      [session()],
      new Map([["s1", { findings: 2, blocking: 1 }]]),
    );
    expect(runs[0].findingsFiled).toBe(2);
    expect(runs[0].blockingFiled).toBe(1);
  });

  it("reports null — never 0 — for a reviewer that has filed nothing", () => {
    const runs = deriveRuns([session()], new Map());
    expect(runs[0].findingsFiled).toBeNull();
    expect(runs[0].blockingFiled).toBeNull();
  });
});

describe("runLastLine", () => {
  const base: QaRun = {
    sessionId: "s1",
    projectId: "p1",
    epicId: "e1",
    readableId: "ARJ-113",
    title: "t",
    agentName: "Security CC",
    startedAt: "2026-08-30T09:00:00.000Z",
    lastLine: "checking migration rollback",
    findingsFiled: null,
    blockingFiled: null,
  };

  it("prefers the filing count over the log line", () => {
    expect(runLastLine({ ...base, findingsFiled: 2, blockingFiled: 1 })).toBe(
      "› 2 findings filed, 1 blocking",
    );
    expect(runLastLine({ ...base, findingsFiled: 1, blockingFiled: 0 })).toBe(
      "› 1 finding filed, 0 blocking",
    );
  });

  it("falls back to the log line, then to an ellipsis — never to prose", () => {
    expect(runLastLine(base)).toBe("› checking migration rollback");
    expect(runLastLine({ ...base, lastLine: null })).toBe("› …");
  });
});

/* ------------------------------------------------------------------ */

const EPICS = new Map<string, QaVerdictEpic>([
  ["e1", { readableId: "ARJ-107", title: "One", status: "done" }],
  ["e2", { readableId: "LDG-83", title: "Two", status: "to_merge" }],
  ["e3", { readableId: "ARJ-110", title: "Three", status: "review" }],
]);

function verdictRow(
  overrides: Partial<QaVerdictSessionRow> = {},
): QaVerdictSessionRow {
  return {
    sessionId: "v1",
    epicId: "e1",
    projectId: "p1",
    reviewVerdict: "approved",
    at: "2026-08-30T09:00:00.000Z",
    findingsFiled: 0,
    ...overrides,
  };
}

/**
 * The verdict sentences as the QA route composes them — resolved from the real
 * `en` catalogue through the same `translatorFor` the route uses. Asserting a
 * hand-written copy of the strings here would pass while the catalogue said
 * something else entirely; this cannot.
 */
const t = translatorFor("en", "Qa");
const VERDICT_COPY: QaVerdictCopy = {
  unverifiable: t("verdicts.unverifiable"),
  changesRequested: (count) => t("verdicts.changesRequested", { count }),
  cleanNoFindings: t("verdicts.cleanNoFindings"),
  cleanWithFindings: (count) => t("verdicts.cleanWithFindings", { count }),
  noStructuredVerdict: t("verdicts.noStructuredVerdict"),
  outcomeLanded: t("verdicts.outcomeLanded"),
  outcomeReady: t("verdicts.outcomeReady"),
  outcomeYourTurn: t("verdicts.outcomeYourTurn"),
};

describe("deriveVerdicts", () => {
  it("says 'review clean · 0 findings' for an approval that filed nothing", () => {
    const [row] = deriveVerdicts([verdictRow()], EPICS, new Set(), VERDICT_COPY);
    expect(row.verdictText).toBe("review clean · 0 findings");
    expect(row.kind).toBe("clean");
    expect(row.outcome).toBe("→ landed");
  });

  it("counts what an approval did file", () => {
    const [row] = deriveVerdicts(
      [verdictRow({ reviewVerdict: "approved_with_minor_issues", findingsFiled: 2 })],
      EPICS,
      new Set(),
      VERDICT_COPY,
    );
    expect(row.verdictText).toBe("clean after review · 2 findings filed");
    expect(row.kind).toBe("clean");
  });

  it("names changes_requested and its count", () => {
    const [row] = deriveVerdicts(
      [verdictRow({ epicId: "e2", reviewVerdict: "changes_requested", findingsFiled: 1 })],
      EPICS,
      new Set(),
      VERDICT_COPY,
    );
    expect(row.verdictText).toBe("changes requested · 1 finding");
    expect(row.kind).toBe("attention");
    expect(row.outcome).toBe("→ ready");
  });

  it("never draws an unverifiable review as clean", () => {
    const [row] = deriveVerdicts(
      [verdictRow({ epicId: "e3", reviewVerdict: null })],
      EPICS,
      new Set(["e3"]),
      VERDICT_COPY,
    );
    expect(row.verdictText).toBe("review unverifiable · findings never received");
    expect(row.kind).toBe("attention");
    expect(row.outcome).toBe("→ your turn");
  });

  it("says so when a provider filed no structured verdict and is not unverifiable", () => {
    const [row] = deriveVerdicts(
      [verdictRow({ reviewVerdict: null })],
      EPICS,
      new Set(),
      VERDICT_COPY,
    );
    expect(row.verdictText).toBe("review with no structured verdict");
    expect(row.kind).toBe("clean");
  });

  it("keeps only the newest session per epic and caps the list", () => {
    const rows = [
      verdictRow({ sessionId: "old", at: "2026-08-01T00:00:00.000Z", findingsFiled: 9 }),
      verdictRow({ sessionId: "new", at: "2026-08-30T00:00:00.000Z" }),
    ];
    const derived = deriveVerdicts(rows, EPICS, new Set(), VERDICT_COPY);
    expect(derived).toHaveLength(1);
    expect(derived[0].verdictText).toBe("review clean · 0 findings");

    const many = Array.from({ length: 9 }, (_, index) =>
      verdictRow({ sessionId: `s${index}`, epicId: `e${index}` }),
    );
    expect(deriveVerdicts(many, EPICS, new Set(), VERDICT_COPY)).toHaveLength(6);
  });
});

describe("outcomeArrow", () => {
  it("names the destination stratum, verbatim", () => {
    expect(outcomeArrow("done", VERDICT_COPY)).toBe("→ landed");
    expect(outcomeArrow("released", VERDICT_COPY)).toBe("→ landed");
    expect(outcomeArrow("to_merge", VERDICT_COPY)).toBe("→ ready");
    expect(outcomeArrow("review", VERDICT_COPY)).toBe("→ your turn");
    expect(outcomeArrow("", VERDICT_COPY)).toBe("→ your turn");
  });
});

describe("deriveCoverage", () => {
  it("answers null — never 0 — for an empty denominator", () => {
    expect(deriveCoverage(0, 0)).toBeNull();
    expect(deriveCoverage(3, 0)).toBeNull();
  });

  it("still answers 0 when nothing shipped was reviewed", () => {
    expect(deriveCoverage(0, 4)).toBe(0);
  });

  it("rounds the same way in both directions", () => {
    expect(deriveCoverage(1, 3)).toBe(33);
    expect(deriveCoverage(2, 3)).toBe(67);
    expect(deriveCoverage(1, 2)).toBe(50);
    expect(deriveCoverage(23, 25)).toBe(92);
  });
});

describe("rubricItemsFromChecklist", () => {
  it("extracts the bold headings of the real feature-review checklist, and nothing else", () => {
    const items = rubricItemsFromChecklist(REVIEW_CHECKLISTS.feature_review);
    expect(items).toEqual([
      "Acceptance Criteria Verification",
      "Functional Completeness",
      "Integration",
      "Tests",
    ]);
  });

  it("ignores bold text that is not a numbered heading", () => {
    expect(
      rubricItemsFromChecklist("- **Severity**: high\n1. **Kept**: yes\ntext"),
    ).toEqual(["Kept"]);
  });

  it("answers an empty list rather than fabricating one", () => {
    expect(rubricItemsFromChecklist("")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* QA CHECKS                                                           */
/* ------------------------------------------------------------------ */

function checkRow(overrides: Partial<QaCheckRow> = {}): QaCheckRow {
  return {
    id: "r1",
    projectId: "p1",
    status: "completed",
    checkType: "tech_check",
    summary: "Two flaky specs and one uncapped column.",
    agentSessionId: "s1",
    sessionStatus: "completed",
    createdAt: "2026-08-01T09:00:00.000Z",
    completedAt: "2026-08-01T09:20:00.000Z",
    ...overrides,
  };
}

describe("checkTypeLabel", () => {
  it("draws the three check kinds the dialog can dispatch", () => {
    expect(checkTypeLabel("tech_check")).toBe("TECH");
    expect(checkTypeLabel("e2e_test")).toBe("E2E");
    expect(checkTypeLabel("failure_digest")).toBe("DIGEST");
  });

  /**
   * `qa_reports.check_type` is free-form TEXT with a `tech_check` DEFAULT, so a
   * row can legally hold a kind this vocabulary has never seen. Folding it into
   * TECH would label somebody else's pass as a tech check; it prints itself.
   */
  it("prints an unknown kind rather than folding it into TECH", () => {
    expect(checkTypeLabel("security_sweep")).toBe("SECURITY_SWEEP");
  });

  it("answers CHECK for a missing or blank kind, never TECH", () => {
    expect(checkTypeLabel(null)).toBe("CHECK");
    expect(checkTypeLabel("   ")).toBe("CHECK");
  });
});

/** A check that really is going: `running` report, non-terminal session. */
function liveRow(overrides: Partial<QaCheckRow> = {}): QaCheckRow {
  return checkRow({
    status: "running",
    sessionStatus: "running",
    summary: null,
    ...overrides,
  });
}

describe("isCheckLive / checkStatusLabel", () => {
  /**
   * THE RULE THAT REPLACED `status === "running"`. `qa_reports.status` has one
   * writer — the tail of the scheduler closure — so a restart, a rejected
   * launch or a cancelled queue entry strands the row on `running` while the
   * SESSION is reconciled to a terminal status. Liveness therefore comes from
   * the session; the report's column is only trusted once it stops saying
   * `running`.
   */
  it("reads a running report behind a live session as live", () => {
    expect(isCheckLive({ status: "running", sessionStatus: "running" })).toBe(true);
    expect(isCheckLive({ status: "running", sessionStatus: "queued" })).toBe(true);
  });

  it("reads a running report behind a finished session as stranded", () => {
    for (const sessionStatus of ["completed", "failed", "cancelled"]) {
      expect(isCheckLive({ status: "running", sessionStatus })).toBe(false);
    }
  });

  it("reads a running report with no session at all as stranded", () => {
    expect(isCheckLive({ status: "running", sessionStatus: null })).toBe(false);
  });

  it("never calls a finished report live, whatever its session says", () => {
    expect(isCheckLive({ status: "completed", sessionStatus: "running" })).toBe(
      false,
    );
    expect(isCheckLive({ status: "failed", sessionStatus: "queued" })).toBe(false);
  });

  /**
   * `interrupted` is derived, never stored. The two alternatives are both
   * lies: `running` is contradicted by the dead session, and the session's own
   * outcome would claim a report whose `report_content` was never written.
   */
  it("labels a stranded report `interrupted`, not `running` and not the session's outcome", () => {
    expect(
      checkStatusLabel({ status: "running", sessionStatus: "cancelled" }),
    ).toBe("interrupted");
    expect(checkStatusLabel({ status: "running", sessionStatus: null })).toBe(
      "interrupted",
    );
  });

  it("passes a finished report's own word straight through", () => {
    expect(
      checkStatusLabel({ status: "completed", sessionStatus: "completed" }),
    ).toBe("completed");
    expect(checkStatusLabel({ status: "failed", sessionStatus: null })).toBe(
      "failed",
    );
    expect(checkStatusLabel({ status: "running", sessionStatus: "running" })).toBe(
      "running",
    );
  });

  /**
   * The two words the REQUEST-TIME writers store (lib/qa/report-lifecycle.ts):
   * a rejected launch closure writes `failed`, a cancelled queue entry writes
   * `cancelled`. Both are ordinary finished-report words here — the screens
   * need no branch for them, which is the whole point of settling the column
   * instead of teaching every reader another special case.
   */
  it("needs no special case for a request-time terminal write", () => {
    for (const status of ["failed", "cancelled"]) {
      expect(checkStatusLabel({ status, sessionStatus: "cancelled" })).toBe(status);
      expect(isCheckLive({ status, sessionStatus: "running" })).toBe(false);
    }
  });
});

describe("sumCheckTotals", () => {
  const byProject = {
    p1: { running: 1, total: 4 },
    p2: { running: 0, total: 9 },
  };

  it("adds up every project the screen is showing", () => {
    expect(sumCheckTotals(byProject, ["p1", "p2"])).toEqual({
      running: 1,
      total: 13,
    });
  });

  it("counts one project alone when the screen is scoped to it", () => {
    expect(sumCheckTotals(byProject, ["p2"])).toEqual({ running: 0, total: 9 });
  });

  /** A project that has never run a check has no key — that is zero, not a gap. */
  it("reads a missing key as zero rather than inventing a row", () => {
    expect(sumCheckTotals(byProject, ["p3"])).toEqual({ running: 0, total: 0 });
    expect(sumCheckTotals({}, ["p1"])).toEqual({ running: 0, total: 0 });
  });
});

describe("deriveChecks", () => {
  it("puts every live check first, then newest first", () => {
    const checks = deriveChecks([
      checkRow({ id: "done-new", createdAt: "2026-08-05T09:00:00.000Z" }),
      liveRow({ id: "running-old", createdAt: "2026-07-01T09:00:00.000Z" }),
      checkRow({ id: "done-old", createdAt: "2026-08-01T09:00:00.000Z" }),
    ]);

    expect(checks.map((check) => check.reportId)).toEqual([
      "running-old",
      "done-new",
      "done-old",
    ]);
  });

  /**
   * The regression this ordering exists to prevent, and the one it caused: a
   * stranded row must NOT be pinned, or `QA_CHECK_LIMIT` of them bury the band.
   */
  it("does not pin a stranded report above the real checks", () => {
    const checks = deriveChecks([
      checkRow({ id: "real", createdAt: "2026-08-20T09:00:00.000Z" }),
      checkRow({
        id: "zombie",
        status: "running",
        sessionStatus: "failed",
        createdAt: "2026-07-01T09:00:00.000Z",
      }),
    ]);

    expect(checks.map((check) => check.reportId)).toEqual(["real", "zombie"]);
    expect(checks.every((check) => !check.live)).toBe(true);
  });

  it("marks `live` from the session, not from the report's own word", () => {
    const live = (status: string, sessionStatus: string | null) =>
      deriveChecks([checkRow({ status, sessionStatus })])[0].live;

    expect(live("running", "running")).toBe(true);
    expect(live("running", "failed")).toBe(false);
    expect(live("completed", "completed")).toBe(false);
    expect(live("cancelled", null)).toBe(false);
  });

  /** An absent stamp is not a fresh one: it sorts last, not first. */
  it("sorts a row with no created_at last", () => {
    const checks = deriveChecks([
      checkRow({ id: "undated", createdAt: null }),
      checkRow({ id: "dated", createdAt: "2026-01-01T09:00:00.000Z" }),
    ]);

    expect(checks.map((check) => check.reportId)).toEqual(["dated", "undated"]);
  });

  it("carries the report id, which is the deep link into the report", () => {
    const [check] = deriveChecks([checkRow({ id: "rep-9" })]);

    expect(check.reportId).toBe("rep-9");
    expect(check.checkLabel).toBe("TECH");
    expect(check.summary).toBe("Two flaky specs and one uncapped column.");
  });

  /**
   * A NULL `status` is read as `running` — the column's own default — and then
   * put through the same liveness rule as any other running row.
   */
  it("falls back to running for a row with no status, never to completed", () => {
    const [live] = deriveChecks([
      checkRow({ status: null, sessionStatus: "running" }),
    ]);
    expect(live.status).toBe("running");
    expect(live.live).toBe(true);

    const [stranded] = deriveChecks([
      checkRow({ status: null, sessionStatus: "failed" }),
    ]);
    expect(stranded.status).toBe("interrupted");
    expect(stranded.live).toBe(false);
  });
});
