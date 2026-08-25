/**
 * Tests for the pipeline's review-verdict assessment
 * (lib/pipeline/findings.ts) against the real migrated schema:
 * severity gating ([critical]/[major] block, [minor]/[info] don't), the
 * open-status and author filters, the stage window (explicit ISO and SQLite
 * CURRENT_TIMESTAMP formats), the prose fallback that only fires when the
 * stage filed zero agent rows, and the structured `submit_findings` verdict
 * that outranks both.
 *
 * The channel-priority matrix (one case per row):
 *
 *   structured verdict | blocking findings | prose  | blocking
 *   ------------------ | ----------------- | ------ | --------
 *   changes_requested  | none              | clean  | YES  (structured wins)
 *   approved           | none              | negative | no  (structured wins)
 *   approved           | [critical] open   | clean  | YES  (findings veto)
 *   none               | none              | negative | YES (prose fallback)
 */
import { describe, it, expect, beforeEach } from "vitest";

import { createTestDb } from "@/lib/db/test-utils";
import {
  projects,
  epics,
  agentSessions,
  reviewComments,
} from "@/lib/db/schema";
import {
  assessReviewOutcome,
  collectBlockingFindings,
  countAgentReviewCommentsSince,
  isNegativeProseVerdict,
  readStructuredReviewVerdict,
  resolveReviewVerdict,
  NEGATIVE_VERDICT_SUBSTRINGS,
  STRUCTURED_REVIEW_VERDICTS,
} from "@/lib/pipeline/findings";

type TestDb = ReturnType<typeof createTestDb>["db"];

let db: TestDb;
let counter = 0;
let epicId: string;
let projectId: string;

const WINDOW_START = "2026-08-17T10:00:00.000Z";
const IN_WINDOW = "2026-08-17T10:05:00.000Z";
const BEFORE_WINDOW = "2026-08-17T09:00:00.000Z";

function seed() {
  counter += 1;
  projectId = `proj-findings-${counter}`;
  epicId = `epic-findings-${counter}`;
  db.insert(projects).values({ id: projectId, name: "Findings" }).run();
  db.insert(epics)
    .values({ id: epicId, projectId, title: "Epic", status: "review", position: 0 })
    .run();
}

let rowCounter = 0;
function insertFinding(input: {
  body: string;
  author?: string;
  status?: string;
  createdAt?: string;
  filePath?: string;
  lineNumber?: number;
}) {
  rowCounter += 1;
  const id = `rc-${counter}-${rowCounter}`;
  db.insert(reviewComments)
    .values({
      id,
      epicId,
      filePath: input.filePath ?? "src/index.ts",
      lineNumber: input.lineNumber ?? 10,
      body: input.body,
      author: input.author ?? "agent",
      status: input.status ?? "open",
      createdAt: input.createdAt ?? IN_WINDOW,
      updatedAt: input.createdAt ?? IN_WINDOW,
    })
    .run();
  return id;
}

/**
 * A review session row, optionally carrying the verdict submit_findings
 * would have persisted on it.
 */
function insertReviewSession(input: {
  reviewVerdict?: string | null;
  startedAt?: string;
} = {}): string {
  rowCounter += 1;
  const id = `sess-${counter}-${rowCounter}`;
  db.insert(agentSessions)
    .values({
      id,
      projectId,
      epicId,
      status: "completed",
      mode: "plan",
      agentType: "review_code",
      outcome: "answered",
      reviewVerdict: input.reviewVerdict ?? null,
      startedAt: input.startedAt ?? WINDOW_START,
      createdAt: input.startedAt ?? WINDOW_START,
    })
    .run();
  return id;
}

beforeEach(() => {
  db = createTestDb().db;
  seed();
});

describe("collectBlockingFindings", () => {
  it("collects open agent [critical] and [major] rows in the window with parsed severity", () => {
    const criticalId = insertFinding({
      body: "[critical] SQL injection in login",
    });
    const majorId = insertFinding({
      body: "[major] Missing error handling",
      filePath: "src/auth.ts",
      lineNumber: 42,
    });

    const findings = collectBlockingFindings(epicId, WINDOW_START, db);
    expect(findings).toHaveLength(2);
    expect(findings).toContainEqual({
      id: criticalId,
      filePath: "src/index.ts",
      lineNumber: 10,
      body: "[critical] SQL injection in login",
      severity: "critical",
    });
    expect(findings).toContainEqual(
      expect.objectContaining({ id: majorId, severity: "major" })
    );
  });

  it("ignores [minor] and [info] severities", () => {
    insertFinding({ body: "[minor] Rename this variable" });
    insertFinding({ body: "[info] Consider a comment here" });
    expect(collectBlockingFindings(epicId, WINDOW_START, db)).toEqual([]);
    // ... but they still count as filed rows (no prose fallback).
    expect(countAgentReviewCommentsSince(epicId, WINDOW_START, db)).toBe(2);
  });

  it("ignores resolved rows, user-authored rows, and rows before the window", () => {
    insertFinding({ body: "[critical] Old resolved one", status: "resolved" });
    insertFinding({ body: "[critical] Human note", author: "user" });
    insertFinding({
      body: "[critical] From a previous review",
      createdAt: BEFORE_WINDOW,
    });
    expect(collectBlockingFindings(epicId, WINDOW_START, db)).toEqual([]);
  });

  it("tolerates SQLite CURRENT_TIMESTAMP-style createdAt via Date.parse on both sides", () => {
    // 'YYYY-MM-DD HH:MM:SS' (no T, no zone) — what a DB-defaulted column
    // stores. Window start far in the past keeps the comparison robust
    // across the local-time interpretation of zoneless strings.
    insertFinding({
      body: "[major] Filed with a DB-default timestamp",
      createdAt: "2026-08-17 12:00:00",
    });
    const findings = collectBlockingFindings(epicId, "2020-01-01T00:00:00.000Z", db);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("major");
  });

  it("excludes rows whose createdAt cannot be dated", () => {
    insertFinding({ body: "[critical] Undatable", createdAt: "not-a-date" });
    expect(collectBlockingFindings(epicId, WINDOW_START, db)).toEqual([]);
    expect(countAgentReviewCommentsSince(epicId, WINDOW_START, db)).toBe(0);
  });
});

describe("isNegativeProseVerdict", () => {
  it("matches the review routes' three substrings, case-insensitively", () => {
    expect(NEGATIVE_VERDICT_SUBSTRINGS).toEqual([
      "changes requested",
      "not complete",
      "partially complete",
    ]);
    expect(
      isNegativeProseVerdict("**Overall Verdict: Changes Requested**")
    ).toBe(true);
    expect(isNegativeProseVerdict("verdict: NOT COMPLETE")).toBe(true);
    expect(isNegativeProseVerdict("Partially Complete, see notes")).toBe(true);
    expect(
      isNegativeProseVerdict("**Overall Verdict: Complete** — ship it")
    ).toBe(false);
    expect(isNegativeProseVerdict("")).toBe(false);
  });
});

describe("assessReviewOutcome", () => {
  it("blocks on structured [critical]/[major] findings", () => {
    insertFinding({ body: "[critical] Broken auth" });
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Complete**",
      database: db,
    });
    expect(assessment.blocking).toBe(true);
    expect(assessment.blockingFindings).toHaveLength(1);
    expect(assessment.usedProseFallback).toBe(false);
  });

  it("passes on minor/info-only findings even when the prose sounds negative", () => {
    // Rows were filed → the structured signal is authoritative; the prose
    // fallback must NOT fire.
    insertFinding({ body: "[minor] nit" });
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "Changes requested for style nits",
      database: db,
    });
    expect(assessment.blocking).toBe(false);
    expect(assessment.usedProseFallback).toBe(false);
    expect(assessment.proseNegative).toBe(true);
  });

  it("falls back to prose ONLY when zero agent rows were filed in the window", () => {
    const negative = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Changes Requested**",
      database: db,
    });
    expect(negative).toMatchObject({
      blocking: true,
      usedProseFallback: true,
      agentCommentCount: 0,
    });

    const positive = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Complete**",
      database: db,
    });
    expect(positive).toMatchObject({ blocking: false, usedProseFallback: true });
  });

  it("second-cycle verdicts ignore first-cycle rows via the fresh window", () => {
    insertFinding({
      body: "[critical] Cycle-1 finding, still open (never auto-resolved)",
      createdAt: IN_WINDOW,
    });
    const secondWindow = "2026-08-17T11:00:00.000Z";
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: secondWindow,
      sessionOutput: "**Overall Verdict: Complete**",
      database: db,
    });
    // Zero rows in the SECOND window → prose fallback → pass, even though
    // the cycle-1 row is still open (humans resolve at approve time).
    expect(assessment).toMatchObject({ blocking: false, usedProseFallback: true });
  });
});

describe("readStructuredReviewVerdict", () => {
  it("returns the verdict submit_findings persisted on the session", () => {
    const sessionId = insertReviewSession({ reviewVerdict: "approved" });
    expect(readStructuredReviewVerdict(sessionId, db)).toBe("approved");
  });

  it("is null for a session that never called the tool, and for no session", () => {
    const sessionId = insertReviewSession();
    expect(readStructuredReviewVerdict(sessionId, db)).toBeNull();
    expect(readStructuredReviewVerdict(null, db)).toBeNull();
    expect(readStructuredReviewVerdict("missing-session", db)).toBeNull();
  });

  it("treats an unrecognised stored value as absent rather than trusting it", () => {
    // The column is free text; a verdict the decision table has no rule for
    // must fall through to the prose channel, not pass as an approval.
    const sessionId = insertReviewSession({ reviewVerdict: "lgtm" });
    expect(readStructuredReviewVerdict(sessionId, db)).toBeNull();
  });

  it("mirrors the submit_findings enum exactly", () => {
    expect(STRUCTURED_REVIEW_VERDICTS).toEqual([
      "approved",
      "approved_with_minor_issues",
      "changes_requested",
    ]);
  });
});

describe("assessReviewOutcome — channel priority matrix", () => {
  it("(1) structured changes_requested beats clean prose", () => {
    const sessionId = insertReviewSession({
      reviewVerdict: "changes_requested",
    });
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Complete** — ship it",
      reviewSessionId: sessionId,
      database: db,
    });
    expect(assessment).toMatchObject({
      blocking: true,
      verdictSource: "structured",
      structuredVerdict: "changes_requested",
      usedProseFallback: false,
      proseNegative: false,
    });
  });

  it("(2) structured approved beats negative prose", () => {
    const sessionId = insertReviewSession({ reviewVerdict: "approved" });
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Changes Requested**",
      reviewSessionId: sessionId,
      database: db,
    });
    expect(assessment).toMatchObject({
      blocking: false,
      verdictSource: "structured",
      structuredVerdict: "approved",
      usedProseFallback: false,
      // The prose scan still ran; it just does not decide.
      proseNegative: true,
    });
  });

  it("(2b) approved_with_minor_issues passes like approved", () => {
    insertFinding({ body: "[minor] naming nit" });
    const sessionId = insertReviewSession({
      reviewVerdict: "approved_with_minor_issues",
    });
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "Some nits, nothing blocking.",
      reviewSessionId: sessionId,
      database: db,
    });
    expect(assessment).toMatchObject({
      blocking: false,
      verdictSource: "structured",
      structuredVerdict: "approved_with_minor_issues",
    });
  });

  it("(3) an open [critical] finding vetoes an approved verdict", () => {
    // The reviewer contradicted itself. The finding is the more specific
    // artifact AND blocks review→done in the engine, so approving here would
    // only push the ticket at a gate that refuses it.
    insertFinding({ body: "[critical] Secrets logged in plaintext" });
    const sessionId = insertReviewSession({ reviewVerdict: "approved" });
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Complete**",
      reviewSessionId: sessionId,
      database: db,
    });
    expect(assessment).toMatchObject({
      blocking: true,
      verdictSource: "structured",
      structuredVerdict: "approved",
    });
    expect(assessment.blockingFindings).toHaveLength(1);
  });

  it("(3b) a RESOLVED [critical] finding no longer vetoes", () => {
    insertFinding({
      body: "[critical] Already fixed and resolved",
      status: "resolved",
    });
    const sessionId = insertReviewSession({ reviewVerdict: "approved" });
    expect(
      assessReviewOutcome({
        epicId,
        sinceIso: WINDOW_START,
        sessionOutput: "**Overall Verdict: Complete**",
        reviewSessionId: sessionId,
        database: db,
      }).blocking
    ).toBe(false);
  });

  it("(4) no structured verdict → the prose fallback decides, bit-for-bit", () => {
    // The gemini-cli case: the provider has no MCP channel, so the only
    // signal is the reviewer's markdown.
    const sessionId = insertReviewSession();
    const negative = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Changes Requested**",
      reviewSessionId: sessionId,
      database: db,
    });
    expect(negative).toMatchObject({
      blocking: true,
      verdictSource: "prose",
      structuredVerdict: null,
      usedProseFallback: true,
      agentCommentCount: 0,
    });

    const positive = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Complete**",
      reviewSessionId: sessionId,
      database: db,
    });
    expect(positive).toMatchObject({
      blocking: false,
      verdictSource: "prose",
      usedProseFallback: true,
    });
  });

  it("(4b) an omitted session id degrades to the pre-structured behaviour", () => {
    insertFinding({ body: "[major] Missing validation" });
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Complete**",
      database: db,
    });
    expect(assessment).toMatchObject({
      blocking: true,
      verdictSource: "prose",
      structuredVerdict: null,
      usedProseFallback: false,
    });
  });

  it("a verdict from ANOTHER session does not decide this stage", () => {
    // Findings rows are epic-keyed and window-filtered, but the verdict is
    // read from the stage's own session row — a previous cycle's approval
    // cannot green-light this one.
    insertReviewSession({ reviewVerdict: "approved" });
    const thisStage = insertReviewSession();
    const assessment = assessReviewOutcome({
      epicId,
      sinceIso: WINDOW_START,
      sessionOutput: "**Overall Verdict: Changes Requested**",
      reviewSessionId: thisStage,
      database: db,
    });
    expect(assessment).toMatchObject({
      blocking: true,
      verdictSource: "prose",
      structuredVerdict: null,
    });
  });
});

describe("resolveReviewVerdict (revert drivers)", () => {
  it("(1) structured changes_requested reverts despite clean prose", () => {
    const sessionId = insertReviewSession({
      reviewVerdict: "changes_requested",
    });
    expect(
      resolveReviewVerdict({
        epicId,
        reviewSessionId: sessionId,
        sessionOutput: "**Overall Verdict: Complete**",
        database: db,
      })
    ).toMatchObject({
      negative: true,
      source: "structured",
      structuredVerdict: "changes_requested",
    });
  });

  it("(2) structured approved holds the ticket despite negative prose", () => {
    const sessionId = insertReviewSession({ reviewVerdict: "approved" });
    expect(
      resolveReviewVerdict({
        epicId,
        reviewSessionId: sessionId,
        sessionOutput: "**Overall Verdict: Changes Requested**",
        database: db,
      })
    ).toMatchObject({
      negative: false,
      source: "structured",
      proseNegative: true,
    });
  });

  it("(3) an open [critical] filed after the session started vetoes approved", () => {
    insertFinding({ body: "[critical] Race condition on retry" });
    const sessionId = insertReviewSession({ reviewVerdict: "approved" });
    const decision = resolveReviewVerdict({
      epicId,
      reviewSessionId: sessionId,
      sessionOutput: "**Overall Verdict: Complete**",
      database: db,
    });
    expect(decision.negative).toBe(true);
    expect(decision.source).toBe("structured");
    expect(decision.blockingFindings).toHaveLength(1);
  });

  it("(3b) a finding predating the session is outside its window", () => {
    insertFinding({
      body: "[critical] Older cycle, still open",
      createdAt: BEFORE_WINDOW,
    });
    const sessionId = insertReviewSession({ reviewVerdict: "approved" });
    expect(
      resolveReviewVerdict({
        epicId,
        reviewSessionId: sessionId,
        sessionOutput: "**Overall Verdict: Complete**",
        database: db,
      })
    ).toMatchObject({ negative: false, blockingFindings: [] });
  });

  it("(4) no structured verdict → pure prose scan, findings rows ignored", () => {
    // Retro-compatibility: this call site never consulted findings rows, so
    // a row-filing reviewer from before the verdict column behaves exactly
    // as it did.
    insertFinding({ body: "[critical] Legacy row, no verdict recorded" });
    const sessionId = insertReviewSession();
    expect(
      resolveReviewVerdict({
        epicId,
        reviewSessionId: sessionId,
        sessionOutput: "**Overall Verdict: Complete**",
        database: db,
      })
    ).toMatchObject({
      negative: false,
      source: "prose",
      structuredVerdict: null,
      blockingFindings: [],
    });

    expect(
      resolveReviewVerdict({
        epicId,
        reviewSessionId: sessionId,
        sessionOutput: "Partially complete — two criteria fail.",
        database: db,
      })
    ).toMatchObject({ negative: true, source: "prose" });
  });

  it("survives a session id that resolves to nothing", () => {
    expect(
      resolveReviewVerdict({
        epicId,
        reviewSessionId: null,
        sessionOutput: "**Overall Verdict: Not Complete**",
        database: db,
      })
    ).toMatchObject({ negative: true, source: "prose" });
  });
});
