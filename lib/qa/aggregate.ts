/**
 * The pure half of frame 11b.
 *
 * `app/api/qa/findings/route.ts` runs the SQL; everything that turns rows into
 * the QA screen's four strata lives here, with no database import, so the whole
 * derivation is testable from plain objects.
 *
 * The rule this module follows everywhere: derive with the EXISTING shared
 * predicates rather than re-deciding anything. In particular it does NOT decide
 * whether a finding blocks — `blocksMergeSql`
 * (`lib/workflow/blocking-findings.ts`) is the single definition of that, it
 * runs in SQL beside the row, and the route hands the answer in. What this
 * module decides is the STAMP: which word and which weight the pill carries.
 * Those two answers are allowed to disagree, and when they do the disagreement
 * is the truth (a `[major]` a later clean verdict superseded is drawn MAJOR and
 * does not block).
 */

import { FINDING_SEVERITY_PREFIXES } from "@/lib/review/finding-severity";

import {
  QA_VERDICT_LIMIT,
  type QaQueuedRun,
  type QaRun,
  type QaSeverityTier,
  type QaVerdict,
} from "./types";

/* ------------------------------------------------------------------ */
/* Severity — the stamp word and its weight                            */
/* ------------------------------------------------------------------ */

export interface QaSeverity {
  severity: string;
  severityLabel: string;
  tier: QaSeverityTier;
}

/**
 * Stamp word + weight for one `review_comments` row.
 *
 * The vocabulary is `lib/review/finding-severity.ts`'s, matched the same way
 * it matches: EXACT, CASE-SENSITIVE prefixes. `[MAJOR]` is deliberately not
 * `[major]` — it lands in `unclassified`, which is what the merge gate does
 * with it too, and an unclassified concern is not a cleared one.
 *
 * Three deliberate choices:
 * - a HUMAN row (any author but `agent`) is `HUMAN`, weighted `blocking`. It
 *   carries no severity vocabulary and it is a deliberate hold;
 * - `[critical]` prints **BLOCKING**, not CRITICAL. That is the frame's word
 *   for the top tier, and the screen reproduces the frame;
 * - `[major]` is weighted `major`, which is the STAMP WEIGHT and not
 *   "non-blocking": a `[major]` still blocks the merge.
 */
export function severityOf(
  body: string | null | undefined,
  author: string | null | undefined,
): QaSeverity {
  if (author !== "agent") {
    return { severity: "human", severityLabel: "HUMAN", tier: "blocking" };
  }

  const text = typeof body === "string" ? body : "";
  const match = FINDING_SEVERITY_PREFIXES.find((entry) =>
    text.startsWith(entry.prefix),
  );

  if (!match) {
    return {
      severity: "unclassified",
      severityLabel: "UNCLASSIFIED",
      tier: "blocking",
    };
  }

  switch (match.severity) {
    case "critical":
      return { severity: "critical", severityLabel: "BLOCKING", tier: "blocking" };
    case "major":
      return { severity: "major", severityLabel: "MAJOR", tier: "major" };
    case "minor":
      return { severity: "minor", severityLabel: "MINOR", tier: "minor" };
    default:
      return { severity: "info", severityLabel: "INFO", tier: "minor" };
  }
}

/**
 * Drop exactly one leading `[severity] ` token, and only one of the four the
 * vocabulary knows. `[foo] bar` is somebody's prose and is left alone.
 */
export function stripSeverityPrefix(body: string | null | undefined): string {
  if (typeof body !== "string") return "";
  const match = FINDING_SEVERITY_PREFIXES.find((entry) =>
    body.startsWith(entry.prefix),
  );
  if (!match) return body;
  const rest = body.slice(match.prefix.length);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

/** Rank for the row order: blocking stamps first, minor last. */
const TIER_RANK: Record<QaSeverityTier, number> = {
  blocking: 0,
  major: 1,
  minor: 2,
};

/** Sort key for the findings list — heaviest stamp first, newest first inside. */
export function compareFindings(
  a: { tier: QaSeverityTier; filedAt: string | null },
  b: { tier: QaSeverityTier; filedAt: string | null },
): number {
  const byTier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (byTier !== 0) return byTier;
  return (b.filedAt ?? "").localeCompare(a.filedAt ?? "");
}

/* ------------------------------------------------------------------ */
/* QA RUNS                                                             */
/* ------------------------------------------------------------------ */

export interface QaSessionRow {
  id: string;
  projectId: string;
  epicId: string | null;
  status: string | null;
  namedAgentName: string | null;
  agentType: string | null;
  startedAt: string | null;
  createdAt: string | null;
  /** Already clipped in SQL — see QA_LOG_LINE_LIMIT. */
  lastLine: string | null;
  epicTitle: string | null;
  epicReadableId: string | null;
}

/** What one live review session has filed so far. */
export interface QaFilingCounts {
  findings: number;
  blocking: number;
}

/**
 * The turquoise cards.
 *
 * Rows reach here ALREADY filtered to the four ordinary review agent types:
 * that list lives in `lib/pipeline/findings.ts`, which imports the database, so
 * the filter is applied by the route and this module stays free of `db`.
 */
export function deriveRuns(
  rows: readonly QaSessionRow[],
  filings: ReadonlyMap<string, QaFilingCounts>,
): QaRun[] {
  return rows
    .filter((row) => row.status === "running")
    .map((row) => {
      const filed = filings.get(row.id);
      return {
        sessionId: row.id,
        projectId: row.projectId,
        epicId: row.epicId,
        readableId: row.epicReadableId,
        title: row.epicTitle ?? "Review",
        agentName: row.namedAgentName ?? row.agentType ?? null,
        // A session with neither a start nor a creation stamp cannot be a
        // chrono; the empty string makes `formatElapsed` print its own dash
        // rather than counting from the epoch.
        startedAt: row.startedAt ?? row.createdAt ?? "",
        lastLine: row.lastLine,
        findingsFiled: filed ? filed.findings : null,
        blockingFiled: filed ? filed.blocking : null,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** The translucent queued tile's rows. */
export function deriveQueued(rows: readonly QaSessionRow[]): QaQueuedRun[] {
  return rows
    .filter((row) => row.status === "queued")
    .map((row) => ({
      sessionId: row.id,
      projectId: row.projectId,
      epicId: row.epicId,
      readableId: row.epicReadableId,
      title: row.epicTitle ?? "Review",
    }));
}

/**
 * The card's last line.
 *
 * A live reviewer that has already filed rows says so — that is the frame's
 * "› 2 findings filed, 1 blocking" and it is the most useful thing the card
 * can print. Otherwise the clipped log line. Otherwise an ellipsis: never a
 * fabricated sentence.
 */
export function runLastLine(run: QaRun): string {
  if (typeof run.findingsFiled === "number" && run.findingsFiled > 0) {
    const n = run.findingsFiled;
    const b = run.blockingFiled ?? 0;
    return `› ${n} finding${n === 1 ? "" : "s"} filed, ${b} blocking`;
  }
  return run.lastLine ? `› ${run.lastLine}` : "› …";
}

/* ------------------------------------------------------------------ */
/* VERDICTS RÉCENTS                                                    */
/* ------------------------------------------------------------------ */

export interface QaVerdictSessionRow {
  sessionId: string;
  epicId: string;
  projectId: string;
  reviewVerdict: string | null;
  /** `sessionAtSql()` — already normalised for lexicographic comparison. */
  at: string | null;
  /** Rows this session filed. */
  findingsFiled: number;
}

export interface QaVerdictEpic {
  readableId: string | null;
  title: string;
  status: string;
}

/**
 * The short reason an unverifiable review row prints.
 *
 * NOT `UNVERIFIABLE_REVIEW_REASON` (`lib/pipeline/findings.ts`): that sentence
 * is written for a prompt and does not fit a 12.5px row. The frame's own
 * "tests timeout" was sample data and would be a lie — the rule is about a
 * `submit_findings` call that never landed, not about tests.
 */
export const QA_UNVERIFIABLE_TEXT = "review unverifiable · findings jamais reçues";

/** Where the ticket went, from its CURRENT status. Verbatim, arrow included. */
export function outcomeArrow(status: string): string {
  if (status === "done" || status === "released") return "→ landed";
  if (status === "to_merge") return "→ ready";
  return "→ your turn";
}

/**
 * The sun stratum's rows: the newest completed ordinary review per epic, in
 * the last {@link QA_VERDICT_DAYS} days, said in one line.
 *
 * THE UNVERIFIABLE BRANCH IS FIRST ON PURPOSE. A reviewer with a working
 * structured channel that filed nothing is missing evidence, not an approval
 * (`lib/pipeline/findings.ts`), and this screen must never draw such a session
 * as clean.
 *
 * `unverifiableEpicIds` is what `listUnverifiableReviewEpicIds` returns — a set
 * of EPIC ids, keyed on that function's own newest-review-per-epic ranking.
 * This function ranks by the same key (`sessionAtSql()` desc, then session id
 * desc), so the two agree on which session the set is talking about; the branch
 * additionally requires the row to carry no structured verdict, which is a
 * precondition of the rule anyway.
 */
export function deriveVerdicts(
  rows: readonly QaVerdictSessionRow[],
  epicsById: ReadonlyMap<string, QaVerdictEpic>,
  unverifiableEpicIds: ReadonlySet<string>,
  limit: number = QA_VERDICT_LIMIT,
): QaVerdict[] {
  const newestByEpic = new Map<string, QaVerdictSessionRow>();
  for (const row of rows) {
    const held = newestByEpic.get(row.epicId);
    if (held !== undefined && !outranks(row, held)) continue;
    newestByEpic.set(row.epicId, row);
  }

  return [...newestByEpic.values()]
    .sort((a, b) => (outranks(a, b) ? -1 : 1))
    .slice(0, limit)
    .map((row) => {
      const epic = epicsById.get(row.epicId);
      const n = row.findingsFiled;
      const plural = n === 1 ? "" : "s";
      const structured =
        row.reviewVerdict === "approved" ||
        row.reviewVerdict === "approved_with_minor_issues" ||
        row.reviewVerdict === "changes_requested";

      let kind: QaVerdict["kind"] = "clean";
      let verdictText: string;

      if (!structured && unverifiableEpicIds.has(row.epicId)) {
        kind = "attention";
        verdictText = QA_UNVERIFIABLE_TEXT;
      } else if (row.reviewVerdict === "changes_requested") {
        kind = "attention";
        verdictText = `changes requested · ${n} finding${plural}`;
      } else if (structured) {
        verdictText =
          n === 0
            ? "review clean · 0 findings"
            : `clean après review · ${n} finding${plural} filed`;
      } else {
        // No structured verdict and not unverifiable: an MCP-less provider
        // reviewed through prose. Saying so is honest; calling it approved
        // would not be.
        verdictText = "review sans verdict structuré";
      }

      return {
        epicId: row.epicId,
        projectId: row.projectId,
        readableId: epic?.readableId ?? null,
        title: epic?.title ?? "",
        verdictText,
        kind,
        outcome: outcomeArrow(epic?.status ?? ""),
        at: row.at,
      };
    });
}

/** `a` is newer than `b` — same tie-break as `listUnverifiableReviewEpicIds`. */
function outranks(a: QaVerdictSessionRow, b: QaVerdictSessionRow): boolean {
  const byAt = (a.at ?? "").localeCompare(b.at ?? "");
  if (byAt !== 0) return byAt > 0;
  return a.sessionId > b.sessionId;
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

/**
 * Percent of tickets shipped in the window that a review actually read.
 *
 * `null` for an empty denominator, and that null is the whole point: "nothing
 * shipped in the last 30 days" is not "0% of what shipped was reviewed". The
 * stat prints an em-dash for the first and `0%` for the second.
 */
export function deriveCoverage(reviewed: number, shipped: number): number | null {
  if (!Number.isFinite(shipped) || shipped <= 0) return null;
  const ratio = Math.max(0, Math.min(1, reviewed / shipped));
  return Math.round(ratio * 100);
}

/* ------------------------------------------------------------------ */
/* La rubrique                                                         */
/* ------------------------------------------------------------------ */

/**
 * The bold headings of a `REVIEW_CHECKLISTS` entry — "1. **Tests**:" → "Tests".
 *
 * Pure and unit-testable: the route passes the markdown string in, because
 * `lib/claude/prompt-sections.ts` transitively imports filesystem code and must
 * never reach the client bundle.
 */
export function rubricItemsFromChecklist(markdown: string): string[] {
  const items: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\d+\.\s+\*\*(.+?)\*\*/.exec(line);
    if (match) items.push(match[1]);
  }
  return items;
}
