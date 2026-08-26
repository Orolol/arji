import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, verifyReports } from "@/lib/db/schema";
import {
  isVerifyCommandResult,
  type VerificationReport,
} from "./verify-constants";

/**
 * Reading the persisted evidence for an epic, in one place.
 *
 * Three call sites need the same question answered — "does a mechanical
 * report vouch for the branch we are about to act on?": Full Auto's merge
 * gate, its review dispatch (which forwards a passing report to the
 * reviewer), and the conflict retry. They must agree, so the query, the
 * freshness rule and the vocabulary for why evidence is unusable live here
 * rather than being reimplemented per caller.
 */

/** Code sessions whose work a report has to be newer than to still apply. */
const CODE_SESSION_TYPES = ["build", "fix", "merge"];

/**
 * Makes two stored timestamps lexically comparable. Reports always store ISO
 * ("2026-08-19T09:05:00.000Z") while a session row that fell back to the
 * schema default carries SQLite's "2026-08-19 09:05:00" — and 'T' (0x54)
 * sorts after ' ' (0x20), so an unnormalised comparison would call every ISO
 * report newer than any same-day default-format session and fail the
 * staleness check open.
 */
export function normalizeInstant(value: string): string {
  return value.includes("T") ? value : value.replace(" ", "T");
}

/** Why the newest report cannot vouch for the branch. */
export type VerificationProblemKind = "missing" | "failed" | "stale";

export interface VerificationProblem {
  kind: VerificationProblemKind;
  /** Reader-facing phrase, used verbatim in activity entries. */
  reason: string;
}

export interface VerificationAssessment {
  /** Newest persisted report, or null when there is none / it is corrupt. */
  report: VerificationReport | null;
  /** Newest code session on the epic — what a re-run would verify. */
  lastCodeSessionId: string | null;
  /** Null when the evidence vouches for the branch. */
  problem: VerificationProblem | null;
}

/**
 * All-or-nothing on the command rows, matching the manual route: a report
 * whose entries are half-readable is evidence nobody should act on, and a
 * shorter list would silently drop exactly the failing command.
 */
function parseReport(
  row: typeof verifyReports.$inferSelect
): VerificationReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.commands);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(isVerifyCommandResult)) {
    return null;
  }
  return {
    id: row.id,
    projectId: row.projectId,
    epicId: row.epicId,
    agentSessionId: row.agentSessionId,
    status: row.status === "pass" ? "pass" : "fail",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    commands: parsed,
  };
}

/**
 * Compares the epic's newest report against its newest code session.
 *
 * `merge` counts as a code session: the conflict-resolution agent edits and
 * commits into the very worktree about to be merged, so a report older than
 * it describes a tree that no longer exists.
 */
export function assessEpicVerification(
  projectId: string,
  epicId: string
): VerificationAssessment {
  const lastCodeSession = db
    .select({
      id: agentSessions.id,
      createdAt: agentSessions.createdAt,
      endedAt: agentSessions.endedAt,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.epicId, epicId),
        inArray(agentSessions.agentType, CODE_SESSION_TYPES)
      )
    )
    .orderBy(desc(agentSessions.createdAt))
    .get();
  const lastCodeSessionId = lastCodeSession?.id ?? null;

  const row = db
    .select()
    .from(verifyReports)
    .where(
      and(
        eq(verifyReports.projectId, projectId),
        eq(verifyReports.epicId, epicId)
      )
    )
    .orderBy(desc(verifyReports.finishedAt), desc(verifyReports.id))
    .get();
  const report = row ? parseReport(row) : null;

  if (!report) {
    return {
      report: null,
      lastCodeSessionId,
      problem: {
        kind: "missing",
        reason: "deterministic verification has never run for this epic",
      },
    };
  }
  if (report.status !== "pass") {
    return {
      report,
      lastCodeSessionId,
      problem: {
        kind: "failed",
        reason: "the latest deterministic verification did not pass",
      },
    };
  }

  const codeEndedAt = lastCodeSession
    ? (lastCodeSession.endedAt ?? lastCodeSession.createdAt)
    : null;
  if (
    codeEndedAt &&
    normalizeInstant(report.finishedAt) < normalizeInstant(codeEndedAt)
  ) {
    return {
      report,
      lastCodeSessionId,
      problem: {
        kind: "stale",
        reason: "the passing verification predates the most recent code session",
      },
    };
  }

  return { report, lastCodeSessionId, problem: null };
}
