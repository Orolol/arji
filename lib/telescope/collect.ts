/**
 * Telescope-lite evidence collector.
 *
 * This module deliberately stops before any LLM call. It reads the project's
 * durable failure evidence, normalizes noisy values mechanically, groups by
 * provider + agent type + failure motif, and returns a strictly bounded set
 * of examples for the later `failure_digest` prompt.
 */
import { and, eq, inArray, like, max, or, sql } from "drizzle-orm";
import { db as defaultDb, type ArijDatabase } from "@/lib/db";
import {
  agentSessionChunks,
  agentSessions,
  epics,
  reviewComments,
  ticketComments,
} from "@/lib/db/schema";
import {
  FORENSIC_COMMENT_HEADING,
  parseForensicDeadSessionId,
} from "@/lib/pipeline/forensic";
import {
  TELESCOPE_MAX_WINDOW_DAYS,
  TELESCOPE_WINDOW_DAYS,
} from "@/lib/telescope/constants";

export {
  TELESCOPE_MAX_WINDOW_DAYS,
  TELESCOPE_WINDOW_DAYS,
} from "@/lib/telescope/constants";
export const TELESCOPE_MAX_GROUPS = 50;
export const TELESCOPE_MAX_EXAMPLES_PER_GROUP = 5;
export const TELESCOPE_MAX_TICKET_IDS_PER_GROUP = 20;
export const TELESCOPE_EVIDENCE_TEXT_MAX_CHARS = 1_000;
export const TELESCOPE_LAST_CHUNK_MAX_CHARS = 1_200;
export const TELESCOPE_MOTIF_MAX_CHARS = 240;
export const TELESCOPE_MAX_PAYLOAD_CHARS = 60_000;
export const TELESCOPE_FINDING_PREFIX_WORDS = 8;
export const TELESCOPE_FINDING_MIN_OCCURRENCES = 2;

const DAY_MS = 24 * 60 * 60 * 1_000;
const UNKNOWN_SIGNATURE_PART = "unknown";
const BLOCKING_FINDING_RE = /^\[(critical|major)\]\s*(.*)$/is;

export type TelescopeEvidenceSource =
  | "session_failure"
  | "transition_refused"
  | "forensic"
  | "finding";

export interface TelescopeChunkExcerpt {
  streamType: string;
  sequence: number;
  content: string;
}

export interface TelescopeEvidence {
  id: string;
  source: TelescopeEvidenceSource;
  occurredAt: string;
  sessionId: string | null;
  /** For forensic comments, the failed session named by the durable marker. */
  relatedSessionId: string | null;
  epicId: string | null;
  userStoryId: string | null;
  provider: string;
  agentType: string;
  status: string | null;
  outcome: string | null;
  message: string;
  error: string | null;
  /** Populated for `transition_refused` evidence. */
  reason: string | null;
  lastChunk: TelescopeChunkExcerpt | null;
  severity: "critical" | "major" | null;
  filePath: string | null;
  lineNumber: number | null;
  motif: string;
  signature: string;
}

export interface TelescopeFailureGroup {
  signature: string;
  provider: string;
  agentType: string;
  motif: string;
  count: number;
  sourceCounts: Record<TelescopeEvidenceSource, number>;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Number of distinct epic/story targets before `ticketIds` is capped. */
  ticketCount: number;
  /** Story id when available, otherwise epic id. */
  ticketIds: string[];
  examples: TelescopeEvidence[];
  omittedExampleCount: number;
}

export interface CollectFailureEvidenceOptions {
  now?: Date;
  windowDays?: number;
  maxGroups?: number;
  maxExamplesPerGroup?: number;
  maxTicketIdsPerGroup?: number;
  maxTextChars?: number;
  maxLastChunkChars?: number;
  maxPayloadChars?: number;
  findingMinOccurrences?: number;
  database?: ArijDatabase;
}

export interface TelescopeCollectionResult {
  projectId: string;
  windowDays: number;
  sinceIso: string;
  untilIso: string;
  /** Evidence rows after source filtering and finding recurrence filtering. */
  evidenceCount: number;
  /** Mechanical groups before the group-count cap. */
  groupCount: number;
  groups: TelescopeFailureGroup[];
  omittedGroupCount: number;
  /** Serialized size of `groups`, ready for the later prompt builder. */
  payloadChars: number;
  truncated: boolean;
}

interface ResolvedOptions {
  now: Date;
  windowDays: number;
  maxGroups: number;
  maxExamplesPerGroup: number;
  maxTicketIdsPerGroup: number;
  maxTextChars: number;
  maxLastChunkChars: number;
  maxPayloadChars: number;
  findingMinOccurrences: number;
  database: ArijDatabase;
}

interface SessionEvidenceRow {
  id: string;
  epicId: string | null;
  userStoryId: string | null;
  status: string | null;
  outcome: string | null;
  provider: string | null;
  agentType: string | null;
  error: string | null;
  lastNonEmptyText: string | null;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  completedAt: string | null;
}

interface FindingCandidate {
  id: string;
  epicId: string;
  sessionId: string | null;
  provider: string | null;
  agentType: string | null;
  filePath: string;
  normalizedFilePath: string;
  lineNumber: number;
  severity: "critical" | "major";
  message: string;
  messagePrefix: string;
  createdAt: string;
}

function boundedNonNegativeInteger(
  value: number | undefined,
  fallback: number,
  maximum: number = fallback
) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(maximum, Math.floor(value));
}

function boundedWindowDays(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return TELESCOPE_WINDOW_DAYS;
  }
  return Math.min(
    TELESCOPE_MAX_WINDOW_DAYS,
    Math.max(1, Math.floor(value))
  );
}

function resolveOptions(
  options: CollectFailureEvidenceOptions
): ResolvedOptions {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("Telescope collection requires a valid clock value");
  }
  return {
    now,
    windowDays: boundedWindowDays(options.windowDays),
    maxGroups: boundedNonNegativeInteger(
      options.maxGroups,
      TELESCOPE_MAX_GROUPS
    ),
    maxExamplesPerGroup: boundedNonNegativeInteger(
      options.maxExamplesPerGroup,
      TELESCOPE_MAX_EXAMPLES_PER_GROUP
    ),
    maxTicketIdsPerGroup: boundedNonNegativeInteger(
      options.maxTicketIdsPerGroup,
      TELESCOPE_MAX_TICKET_IDS_PER_GROUP
    ),
    maxTextChars: boundedNonNegativeInteger(
      options.maxTextChars,
      TELESCOPE_EVIDENCE_TEXT_MAX_CHARS
    ),
    maxLastChunkChars: boundedNonNegativeInteger(
      options.maxLastChunkChars,
      TELESCOPE_LAST_CHUNK_MAX_CHARS
    ),
    maxPayloadChars: Math.max(
      2,
      boundedNonNegativeInteger(
        options.maxPayloadChars,
        TELESCOPE_MAX_PAYLOAD_CHARS
      )
    ),
    findingMinOccurrences: Math.max(
      2,
      boundedNonNegativeInteger(
        options.findingMinOccurrences,
        TELESCOPE_FINDING_MIN_OCCURRENCES,
        Number.MAX_SAFE_INTEGER
      )
    ),
    database: options.database ?? defaultDb,
  };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isWithinWindow(
  value: string | null | undefined,
  sinceMs: number,
  untilMs: number
): value is string {
  const parsed = parseTimestamp(value);
  return parsed !== null && parsed >= sinceMs && parsed <= untilMs;
}

function sessionTerminalAt(row: SessionEvidenceRow): string | null {
  return row.endedAt ?? row.completedAt ?? row.startedAt ?? row.createdAt;
}

function trimHead(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (maxChars <= 0) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return maxChars === 1 ? "…" : `${trimmed.slice(0, maxChars - 1)}…`;
}

function trimTail(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (maxChars <= 0) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return maxChars === 1 ? "…" : `…${trimmed.slice(-(maxChars - 1))}`;
}

/** Normalizes the two categorical parts of a signature. */
export function normalizeFailureDimension(value: string | null | undefined) {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_.-]/g, "");
  return normalized || UNKNOWN_SIGNATURE_PART;
}

/**
 * Removes run-specific noise while retaining the recognisable error shape.
 * The replacements are intentionally conservative and deterministic: this is
 * pre-grouping, not semantic diagnosis.
 */
export function normalizeFailureMotif(value: string): string {
  const normalized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/<!--\s*arij:[^>]*-->/gi, " ")
    .replace(/^\[(critical|major)\]\s*/i, "")
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/gi, "<timestamp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(
      /\b(?=[0-9a-f]{7,64}\b)(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]+\b/gi,
      "<hash>"
    )
    .replace(/(?:file:\/\/)?\/(?:[^\s:'\"`]+\/)+[^\s:'\"`]+/g, "<path>")
    .replace(/:\d+(?::\d+)?\b/g, ":<n>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/[`*_#|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) return "unspecified_failure";
  if (normalized.length <= TELESCOPE_MOTIF_MAX_CHARS) return normalized;
  return normalized.slice(0, TELESCOPE_MOTIF_MAX_CHARS).trimEnd();
}

export function buildFailureSignature(input: {
  provider: string | null | undefined;
  agentType: string | null | undefined;
  motif: string;
}): {
  signature: string;
  provider: string;
  agentType: string;
  motif: string;
} {
  const provider = normalizeFailureDimension(input.provider);
  const agentType = normalizeFailureDimension(input.agentType);
  const motif = normalizeFailureMotif(input.motif);
  return {
    signature: `${provider}::${agentType}::${motif}`,
    provider,
    agentType,
    motif,
  };
}

function normalizeFindingPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** A stable, intentionally short prefix for cross-file recurring findings. */
export function normalizeFindingMessagePrefix(value: string): string {
  const normalized = normalizeFailureMotif(value);
  const firstClause = normalized.split(/(?:\r?\n|\s+[—–]\s+|[.:;]\s+)/, 1)[0];
  return firstClause
    .split(/\s+/)
    .slice(0, TELESCOPE_FINDING_PREFIX_WORDS)
    .join(" ");
}

function loadLatestChunks(
  database: ArijDatabase,
  sessionIds: string[],
  maxChars: number
): Map<string, TelescopeChunkExcerpt> {
  const wanted = new Set(sessionIds);
  const latest = new Map<string, TelescopeChunkExcerpt>();
  if (wanted.size === 0) return latest;

  // Read only each session's maximum sequence first, then fetch the matching
  // rows. This keeps raw chunk bodies out of memory except for the winners.
  // Batch sizes stay below SQLite's usual 999-parameter ceiling: the second
  // query uses two bound values per session.
  for (let start = 0; start < sessionIds.length; start += 400) {
    const ids = sessionIds.slice(start, start + 400);
    const latestSequences = database
      .select({
        sessionId: agentSessionChunks.sessionId,
        sequence: max(agentSessionChunks.sequence),
      })
      .from(agentSessionChunks)
      .where(inArray(agentSessionChunks.sessionId, ids))
      .groupBy(agentSessionChunks.sessionId)
      .all()
      .filter(
        (row): row is { sessionId: string; sequence: number } =>
          row.sequence !== null
      );
    const latestPredicate = or(
      ...latestSequences.map((row) =>
        and(
          eq(agentSessionChunks.sessionId, row.sessionId),
          eq(agentSessionChunks.sequence, row.sequence)
        )
      )
    );
    if (!latestPredicate) continue;

    for (const row of database
      .select({
        sessionId: agentSessionChunks.sessionId,
        streamType: agentSessionChunks.streamType,
        sequence: agentSessionChunks.sequence,
        content: agentSessionChunks.content,
      })
      .from(agentSessionChunks)
      .where(latestPredicate)
      .all()) {
      latest.set(row.sessionId, {
        streamType: row.streamType,
        sequence: row.sequence,
        content: trimTail(row.content, maxChars),
      });
    }
  }
  return latest;
}

function collectSessionEvidence(
  projectId: string,
  options: ResolvedOptions,
  sinceMs: number,
  untilMs: number
): TelescopeEvidence[] {
  const sinceIso = new Date(sinceMs).toISOString();
  const untilIso = new Date(untilMs).toISOString();
  const rows: SessionEvidenceRow[] = options.database
    .select({
      id: agentSessions.id,
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
      status: agentSessions.status,
      outcome: agentSessions.outcome,
      provider: agentSessions.provider,
      agentType: agentSessions.agentType,
      error: agentSessions.error,
      lastNonEmptyText: agentSessions.lastNonEmptyText,
      createdAt: agentSessions.createdAt,
      startedAt: agentSessions.startedAt,
      endedAt: agentSessions.endedAt,
      completedAt: agentSessions.completedAt,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        or(
          eq(agentSessions.status, "failed"),
          inArray(agentSessions.outcome, ["silent", "transition_refused"])
        ),
        sql`datetime(coalesce(${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.startedAt}, ${agentSessions.createdAt})) >= datetime(${sinceIso})`,
        sql`datetime(coalesce(${agentSessions.endedAt}, ${agentSessions.completedAt}, ${agentSessions.startedAt}, ${agentSessions.createdAt})) <= datetime(${untilIso})`
      )
    )
    .all()
    .filter((row) => {
      const eligible =
        row.outcome === "transition_refused" ||
        row.outcome === "silent" ||
        row.status === "failed";
      return (
        eligible &&
        isWithinWindow(sessionTerminalAt(row), sinceMs, untilMs)
      );
    });

  const chunks = loadLatestChunks(
    options.database,
    rows.map((row) => row.id),
    options.maxLastChunkChars
  );

  return rows.map((row) => {
    const source: TelescopeEvidenceSource =
      row.outcome === "transition_refused"
        ? "transition_refused"
        : "session_failure";
    const lastChunk = chunks.get(row.id) ?? null;
    const fallback = row.outcome === "silent" ? "silent session" : "failed session";
    const fullMessage =
      row.error?.trim() ||
      row.lastNonEmptyText?.trim() ||
      lastChunk?.content.trim() ||
      fallback;
    const signature = buildFailureSignature({
      provider: row.provider,
      agentType: row.agentType,
      motif: fullMessage,
    });
    const reason =
      row.outcome === "transition_refused"
        ? trimHead(row.error?.trim() || "transition refused without a stored reason", options.maxTextChars)
        : null;

    return {
      id: `session:${row.id}`,
      source,
      occurredAt: sessionTerminalAt(row)!,
      sessionId: row.id,
      relatedSessionId: null,
      epicId: row.epicId,
      userStoryId: row.userStoryId,
      provider: signature.provider,
      agentType: signature.agentType,
      status: row.status,
      outcome: row.outcome,
      message: trimHead(fullMessage, options.maxTextChars),
      error: row.error ? trimHead(row.error, options.maxTextChars) : null,
      reason,
      lastChunk,
      severity: null,
      filePath: null,
      lineNumber: null,
      motif: signature.motif,
      signature: signature.signature,
    };
  });
}

function stripForensicMetadata(content: string): string {
  return content
    .slice(FORENSIC_COMMENT_HEADING.length)
    .replace(/<!--\s*arij:dead-session=[^>]*-->/i, "")
    .trim();
}

function loadSessionDimensions(
  database: ArijDatabase,
  projectId: string,
  sessionIds: string[]
): Map<string, { provider: string | null; agentType: string | null }> {
  const dimensions = new Map<
    string,
    { provider: string | null; agentType: string | null }
  >();
  const uniqueIds = [...new Set(sessionIds)];
  for (let start = 0; start < uniqueIds.length; start += 400) {
    const ids = uniqueIds.slice(start, start + 400);
    if (ids.length === 0) continue;
    for (const row of database
      .select({
        id: agentSessions.id,
        provider: agentSessions.provider,
        agentType: agentSessions.agentType,
      })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.projectId, projectId),
          inArray(agentSessions.id, ids)
        )
      )
      .all()) {
      dimensions.set(row.id, {
        provider: row.provider,
        agentType: row.agentType,
      });
    }
  }
  return dimensions;
}

function collectForensicEvidence(
  projectId: string,
  options: ResolvedOptions,
  sinceMs: number,
  untilMs: number
): TelescopeEvidence[] {
  const sinceIso = new Date(sinceMs).toISOString();
  const untilIso = new Date(untilMs).toISOString();
  const rows = options.database
    .select({
      id: ticketComments.id,
      epicId: ticketComments.epicId,
      userStoryId: ticketComments.userStoryId,
      sessionId: ticketComments.agentSessionId,
      content: ticketComments.content,
      createdAt: ticketComments.createdAt,
      provider: agentSessions.provider,
      agentType: agentSessions.agentType,
    })
    .from(ticketComments)
    .innerJoin(epics, eq(ticketComments.epicId, epics.id))
    .leftJoin(agentSessions, eq(ticketComments.agentSessionId, agentSessions.id))
    .where(
      and(
        eq(epics.projectId, projectId),
        eq(ticketComments.author, "agent"),
        like(ticketComments.content, `${FORENSIC_COMMENT_HEADING}%`),
        sql`datetime(${ticketComments.createdAt}) >= datetime(${sinceIso})`,
        sql`datetime(${ticketComments.createdAt}) <= datetime(${untilIso})`
      )
    )
    .all()
    .filter(
      (row) =>
        row.content.startsWith(FORENSIC_COMMENT_HEADING) &&
        isWithinWindow(row.createdAt, sinceMs, untilMs)
    );
  const rowsWithRelatedSession = rows.map((row) => ({
    ...row,
    relatedSessionId: parseForensicDeadSessionId(row.content),
  }));
  const relatedDimensions = loadSessionDimensions(
    options.database,
    projectId,
    rowsWithRelatedSession.flatMap((row) =>
      row.relatedSessionId ? [row.relatedSessionId] : []
    )
  );

  return rowsWithRelatedSession.map((row) => {
      const diagnostic = stripForensicMetadata(row.content) || "empty forensic diagnostic";
      const failedSession = row.relatedSessionId
        ? relatedDimensions.get(row.relatedSessionId)
        : undefined;
      const signature = buildFailureSignature({
        provider: failedSession?.provider ?? row.provider,
        agentType: failedSession?.agentType ?? row.agentType ?? "forensic",
        motif: diagnostic,
      });
      return {
        id: `forensic:${row.id}`,
        source: "forensic" as const,
        occurredAt: row.createdAt!,
        sessionId: row.sessionId,
        relatedSessionId: row.relatedSessionId,
        epicId: row.epicId,
        userStoryId: row.userStoryId,
        provider: signature.provider,
        agentType: signature.agentType,
        status: null,
        outcome: null,
        message: trimHead(diagnostic, options.maxTextChars),
        error: null,
        reason: null,
        lastChunk: null,
        severity: null,
        filePath: null,
        lineNumber: null,
        motif: signature.motif,
        signature: signature.signature,
      };
    });
}

function collectFindingCandidates(
  projectId: string,
  options: ResolvedOptions,
  sinceMs: number,
  untilMs: number
): FindingCandidate[] {
  const candidates: FindingCandidate[] = [];
  const sinceIso = new Date(sinceMs).toISOString();
  const untilIso = new Date(untilMs).toISOString();
  const rows = options.database
    .select({
      id: reviewComments.id,
      epicId: reviewComments.epicId,
      filePath: reviewComments.filePath,
      lineNumber: reviewComments.lineNumber,
      body: reviewComments.body,
      sessionId: reviewComments.agentSessionId,
      createdAt: reviewComments.createdAt,
      provider: agentSessions.provider,
      agentType: agentSessions.agentType,
    })
    .from(reviewComments)
    .innerJoin(epics, eq(reviewComments.epicId, epics.id))
    .leftJoin(agentSessions, eq(reviewComments.agentSessionId, agentSessions.id))
    .where(
      and(
        eq(epics.projectId, projectId),
        eq(reviewComments.author, "agent"),
        or(
          like(sql<string>`lower(ltrim(${reviewComments.body}))`, "[critical]%"),
          like(sql<string>`lower(ltrim(${reviewComments.body}))`, "[major]%")
        ),
        sql`datetime(${reviewComments.createdAt}) >= datetime(${sinceIso})`,
        sql`datetime(${reviewComments.createdAt}) <= datetime(${untilIso})`
      )
    )
    .all();

  for (const row of rows) {
    if (!isWithinWindow(row.createdAt, sinceMs, untilMs)) continue;
    const match = row.body.trim().match(BLOCKING_FINDING_RE);
    if (!match) continue;
    const severity = match[1].toLowerCase() as "critical" | "major";
    const message = match[2].trim() || row.body.trim();
    candidates.push({
      id: row.id,
      epicId: row.epicId,
      sessionId: row.sessionId,
      provider: row.provider,
      agentType: row.agentType,
      filePath: row.filePath,
      normalizedFilePath: normalizeFindingPath(row.filePath),
      lineNumber: row.lineNumber,
      severity,
      message,
      messagePrefix: normalizeFindingMessagePrefix(message),
      createdAt: row.createdAt!,
    });
  }
  return candidates;
}

function collectRecurringFindingEvidence(
  projectId: string,
  options: ResolvedOptions,
  sinceMs: number,
  untilMs: number
): TelescopeEvidence[] {
  const candidates = collectFindingCandidates(
    projectId,
    options,
    sinceMs,
    untilMs
  );
  const pathCounts = new Map<string, number>();
  const prefixCounts = new Map<string, number>();
  const recurrenceKey = (finding: FindingCandidate, motif: string) =>
    `${normalizeFailureDimension(finding.provider)}::${normalizeFailureDimension(
      finding.agentType
    )}::${motif}`;
  for (const finding of candidates) {
    if (finding.normalizedFilePath) {
      const pathKey = recurrenceKey(
        finding,
        `file:${finding.normalizedFilePath}`
      );
      pathCounts.set(
        pathKey,
        (pathCounts.get(pathKey) ?? 0) + 1
      );
    }
    if (finding.messagePrefix) {
      const prefixKey = recurrenceKey(
        finding,
        `message:${finding.messagePrefix}`
      );
      prefixCounts.set(
        prefixKey,
        (prefixCounts.get(prefixKey) ?? 0) + 1
      );
    }
  }

  const evidence: TelescopeEvidence[] = [];
  for (const finding of candidates) {
    const pathCount =
      pathCounts.get(
        recurrenceKey(finding, `file:${finding.normalizedFilePath}`)
      ) ?? 0;
    const prefixCount =
      prefixCounts.get(
        recurrenceKey(finding, `message:${finding.messagePrefix}`)
      ) ?? 0;
    if (
      pathCount < options.findingMinOccurrences &&
      prefixCount < options.findingMinOccurrences
    ) {
      continue;
    }

    // Pick the recurrent key with the widest support. A tie favours the file
    // anchor because it is explicit structured data rather than prose.
    const motif =
      pathCount >= options.findingMinOccurrences && pathCount >= prefixCount
        ? `finding file ${finding.normalizedFilePath}`
        : `finding message ${finding.messagePrefix}`;
    const signature = buildFailureSignature({
      provider: finding.provider,
      agentType: finding.agentType,
      motif,
    });
    evidence.push({
      id: `finding:${finding.id}`,
      source: "finding",
      occurredAt: finding.createdAt,
      sessionId: finding.sessionId,
      relatedSessionId: null,
      epicId: finding.epicId,
      userStoryId: null,
      provider: signature.provider,
      agentType: signature.agentType,
      status: null,
      outcome: null,
      message: trimHead(finding.message, options.maxTextChars),
      error: null,
      reason: null,
      lastChunk: null,
      severity: finding.severity,
      filePath: trimHead(finding.filePath, options.maxTextChars),
      lineNumber: finding.lineNumber,
      motif: signature.motif,
      signature: signature.signature,
    });
  }
  return evidence;
}

function emptySourceCounts(): Record<TelescopeEvidenceSource, number> {
  return {
    session_failure: 0,
    transition_refused: 0,
    forensic: 0,
    finding: 0,
  };
}

function groupEvidence(
  evidence: TelescopeEvidence[],
  options: ResolvedOptions
): TelescopeFailureGroup[] {
  const buckets = new Map<string, TelescopeEvidence[]>();
  for (const item of evidence) {
    const bucket = buckets.get(item.signature) ?? [];
    bucket.push(item);
    buckets.set(item.signature, bucket);
  }

  const groups: TelescopeFailureGroup[] = [];
  for (const [signature, items] of buckets) {
    items.sort((a, b) => {
      const byTime = (parseTimestamp(b.occurredAt) ?? 0) - (parseTimestamp(a.occurredAt) ?? 0);
      return byTime || a.id.localeCompare(b.id);
    });
    const sourceCounts = emptySourceCounts();
    const ticketIds = new Set<string>();
    for (const item of items) {
      sourceCounts[item.source] += 1;
      const ticketId = item.userStoryId ?? item.epicId;
      if (ticketId) ticketIds.add(ticketId);
    }
    const oldest = items[items.length - 1];
    const newest = items[0];
    groups.push({
      signature,
      provider: newest.provider,
      agentType: newest.agentType,
      motif: newest.motif,
      count: items.length,
      sourceCounts,
      firstSeenAt: oldest.occurredAt,
      lastSeenAt: newest.occurredAt,
      ticketCount: ticketIds.size,
      ticketIds: [...ticketIds]
        .sort()
        .slice(0, options.maxTicketIdsPerGroup),
      examples: items.slice(0, options.maxExamplesPerGroup),
      omittedExampleCount: Math.max(
        0,
        items.length - options.maxExamplesPerGroup
      ),
    });
  }

  return groups.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const byRecency =
      (parseTimestamp(b.lastSeenAt) ?? 0) - (parseTimestamp(a.lastSeenAt) ?? 0);
    return byRecency || a.signature.localeCompare(b.signature);
  });
}

function boundGroupsForPrompt(
  allGroups: TelescopeFailureGroup[],
  options: ResolvedOptions
): TelescopeFailureGroup[] {
  const groups = allGroups.slice(0, options.maxGroups).map((group) => ({
    ...group,
    ticketIds: [...group.ticketIds],
    examples: [...group.examples],
  }));

  const payloadSize = () => JSON.stringify(groups).length;
  while (groups.length > 0 && payloadSize() > options.maxPayloadChars) {
    // Preserve at least one concrete example in the higher-priority groups:
    // first shed surplus examples from the least important group.
    const surplusIndex = groups.findLastIndex(
      (group) => group.examples.length > 1
    );
    if (surplusIndex >= 0) {
      groups[surplusIndex].examples.pop();
      groups[surplusIndex].omittedExampleCount += 1;
      continue;
    }

    // Then shed the lowest-frequency/oldest group. If only one group remains,
    // its single example may be removed before the final metadata-only group.
    if (groups.length > 1) {
      groups.pop();
      continue;
    }
    if (groups[0].examples.length > 0) {
      groups[0].examples.pop();
      groups[0].omittedExampleCount += 1;
      continue;
    }
    groups.pop();
  }
  return groups;
}

/**
 * Collect and mechanically pre-group recurring project failures.
 *
 * The returned payload is bounded by group count, examples per group, ticket
 * ids per group, and per-field character caps. Counts still describe the
 * complete window, so the future digest agent sees frequency without being
 * handed every raw trace.
 */
export function collectFailureDigestEvidence(
  projectId: string,
  rawOptions: CollectFailureEvidenceOptions = {}
): TelescopeCollectionResult {
  const options = resolveOptions(rawOptions);
  const untilMs = options.now.getTime();
  const sinceMs = untilMs - options.windowDays * DAY_MS;
  const evidence = [
    ...collectSessionEvidence(projectId, options, sinceMs, untilMs),
    ...collectForensicEvidence(projectId, options, sinceMs, untilMs),
    ...collectRecurringFindingEvidence(projectId, options, sinceMs, untilMs),
  ];
  const allGroups = groupEvidence(evidence, options);
  const groups = boundGroupsForPrompt(allGroups, options);
  const payloadChars = JSON.stringify(groups).length;

  return {
    projectId,
    windowDays: options.windowDays,
    sinceIso: new Date(sinceMs).toISOString(),
    untilIso: options.now.toISOString(),
    evidenceCount: evidence.length,
    groupCount: allGroups.length,
    groups,
    omittedGroupCount: Math.max(0, allGroups.length - groups.length),
    payloadChars,
    truncated:
      allGroups.length > groups.length ||
      groups.some(
        (group) =>
          group.omittedExampleCount > 0 ||
          group.ticketCount > group.ticketIds.length
      ),
  };
}

/** Short alias for callers that already live under `lib/telescope`. */
export const collectFailureEvidence = collectFailureDigestEvidence;
