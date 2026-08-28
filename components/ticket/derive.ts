/**
 * Pure derivations for the ticket overlay (frame 6a).
 *
 * No React, no fetch, no DOM — everything here is a function of data the
 * overlay already has, so it is unit-testable without mounting anything.
 * `hooks/useTicketOverlayData.ts` calls into this module; the band components
 * receive the results as plain props.
 */

import type { PipelineStep } from "@/components/piscine";
import type { TimelineKind } from "@/components/piscine";
import type { EpicActivityEntry } from "@/hooks/useEpicActivity";
import type { FeedItem } from "@/lib/kanban/activity-feed";
import { MCP_CREATE_BUG_ACTIVITY_PREFIX } from "@/lib/mcp/create-bug-contract";
import type { ProjectTone } from "@/lib/piscine/tokens";
import { COLUMN_LABELS, PRIORITY_LABELS } from "@/lib/types/kanban";
import { timeAgo } from "@/lib/utils/format-date";

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Last 6 characters of an id, the fallback ticket label when a row predates
 * `epics.readable_id`. Never renders an empty chip: an id shorter than 6
 * characters is used whole.
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return "";
  return id.length <= 6 ? id : id.slice(-6);
}

/** `epic.readableId`, falling back to the tail of the raw id. */
export function ticketLabel(
  readableId: string | null | undefined,
  id: string | null | undefined,
): string {
  const trimmed = readableId?.trim();
  if (trimmed) return trimmed;
  return shortId(id);
}

/**
 * Stable 32-bit string hash (FNV-1a). The project palette is picked from
 * `projects.colorIndex` when that column exists; until then a project still
 * has to keep the SAME colour between two opens of the same ticket, so the id
 * is hashed instead of being assigned a random or list-position tone.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The tone index to hand `projectTone()`. Prefers the stored colour index and
 * falls back to the id hash, so this keeps working unchanged the day
 * `projects.colorIndex` lands.
 */
export function projectToneIndex(
  projectId: string | null | undefined,
  colorIndex?: number | null,
): number {
  if (typeof colorIndex === "number" && Number.isFinite(colorIndex)) {
    return colorIndex;
  }
  return hashString(projectId ?? "");
}

/* ------------------------------------------------------------------ */
/* User stories                                                        */
/* ------------------------------------------------------------------ */

/**
 * `user_stories.acceptance_criteria` is a single nullable text column, not a
 * table: the criteria are one per line. Blank lines never count, so an empty
 * or whitespace-only column is 0 — and 0 means the "n AC" chip is omitted
 * entirely rather than rendered as "0 AC".
 */
export function countAcceptanceCriteria(raw: string | null | undefined): number {
  if (!raw) return 0;
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

const SPEC_DONE = new Set([
  "todo",
  "in_progress",
  "review",
  "to_merge",
  "done",
  "released",
]);
const BUILD_DONE = new Set(["review", "to_merge", "done", "released"]);
const REVIEW_DONE = new Set(["to_merge", "done", "released"]);
const LAND_DONE = new Set(["done", "released"]);

/**
 * The four-step chain in the PIPELINE card, derived from the board column.
 *
 * `live` is conjoined with `isRunning` on purpose: `PipelineChain` draws a
 * live step as a *breathing* dot, and in this design motion means something is
 * actually alive. A ticket parked in `in_progress` with no session shows BUILD
 * as a pending ring, which is the truth.
 */
export function pipelineSteps(
  status: string,
  isRunning: boolean,
): PipelineStep[] {
  const step = (
    label: string,
    done: boolean,
    liveColumn: string,
  ): PipelineStep => ({
    label,
    state: done
      ? "done"
      : isRunning && status === liveColumn
        ? "live"
        : "pending",
  });

  return [
    step("SPEC", SPEC_DONE.has(status), "backlog"),
    step("BUILD", BUILD_DONE.has(status), "in_progress"),
    step("REVIEW", REVIEW_DONE.has(status), "review"),
    step("LAND", LAND_DONE.has(status), "to_merge"),
  ];
}

/* ------------------------------------------------------------------ */
/* Git                                                                 */
/* ------------------------------------------------------------------ */

export interface DiffTotals {
  /** null until the deferred diff fetch resolves, and on any failure. */
  added: number | null;
  removed: number | null;
  files: number | null;
}

/** The pre-fetch / failed state: em-dashes downstream, never zeros. */
export const UNKNOWN_DIFF_TOTALS: DiffTotals = {
  added: null,
  removed: null,
  files: null,
};

interface DiffShape {
  files?: Array<{ hunks?: Array<{ lines?: Array<{ type?: string }> }> }>;
}

/**
 * Sum `+`/`−` line counts across every hunk of every file of a `DiffResult`.
 * A payload without a `files` array is treated as unavailable (em-dashes), not
 * as an empty diff — "we could not read it" and "there is nothing" must not
 * render the same.
 */
export function diffTotals(result: DiffShape | null | undefined): DiffTotals {
  if (!result || !Array.isArray(result.files)) return UNKNOWN_DIFF_TOTALS;

  let added = 0;
  let removed = 0;
  for (const file of result.files) {
    for (const hunk of file.hunks ?? []) {
      for (const line of hunk.lines ?? []) {
        if (line.type === "add") added += 1;
        else if (line.type === "del") removed += 1;
      }
    }
  }
  return { added, removed, files: result.files.length };
}

/* ------------------------------------------------------------------ */
/* Dependencies                                                        */
/* ------------------------------------------------------------------ */

export interface DependencyRowItem {
  /** Raw epic id — the React key and the click target. */
  id: string;
  /** `readableId` when known, the id tail otherwise. Never empty. */
  label: string;
  /** null when the id resolves to no epic in this project. */
  title: string | null;
}

export interface EpicIndexEntry {
  readableId?: string | null;
  title?: string | null;
}

/**
 * One candidate in the WAITS ON editor: every other ticket of the project,
 * carrying whether this ticket already waits on it.
 *
 * Only the WAITS ON side is editable, and that is not a simplification: the
 * dependencies route stores one edge per (ticket, dependsOnTicket) pair and
 * `PUT …/dependencies` replaces THIS ticket's predecessor list. A BLOCKS edge
 * is the other ticket's predecessor row, so it is edited from that ticket.
 */
export interface DependencyOption {
  id: string;
  /** `readableId` when known, the id tail otherwise. Never empty. */
  label: string;
  title: string | null;
  selected: boolean;
}

/** The project's other tickets, marked with the current WAITS ON selection. */
export function dependencyOptions(
  rows: ReadonlyArray<{ id: string; readableId?: string | null; title?: string | null }>,
  selfId: string | null,
  waitsOnIds: readonly string[],
): DependencyOption[] {
  const selected = new Set(waitsOnIds);
  const options: DependencyOption[] = [];
  for (const row of rows) {
    if (!row.id || row.id === selfId) continue;
    options.push({
      id: row.id,
      label: ticketLabel(row.readableId, row.id),
      title: row.title?.trim() ? row.title : null,
      selected: selected.has(row.id),
    });
  }
  return options;
}

/** Add or drop one predecessor, preserving the order of the rest. */
export function toggledWaitsOn(
  waitsOnIds: readonly string[],
  epicId: string,
): string[] {
  return waitsOnIds.includes(epicId)
    ? waitsOnIds.filter((id) => id !== epicId)
    : [...waitsOnIds, epicId];
}

/**
 * `DependencyRecord` carries ids only. Resolve them through an index built
 * from the project's epic list; an id that resolves to nothing keeps its chip
 * (the edge is real) and simply has no title.
 */
export function dependencyRowItems(
  records: Array<{ ticketId: string; dependsOnTicketId: string }>,
  /**
   * `successors` name the ticket that depends on this one (BLOCKS), so read
   * `ticketId`; `predecessors` name the ticket this one waits on, so read
   * `dependsOnTicketId`. Verified against the dependencies route.
   */
  side: "ticketId" | "dependsOnTicketId",
  index: ReadonlyMap<string, EpicIndexEntry>,
): DependencyRowItem[] {
  const seen = new Set<string>();
  const items: DependencyRowItem[] = [];
  for (const record of records) {
    const id = record[side];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = index.get(id);
    items.push({
      id,
      label: ticketLabel(entry?.readableId, id),
      title: entry?.title?.trim() ? entry.title : null,
    });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Session / timeline                                                  */
/* ------------------------------------------------------------------ */

/**
 * `/sessions/active` returns `UnifiedActivity` rows whose agent action lives
 * in `type`; older/registry shapes only carry `agentType` or `mode`. All three
 * are live in the wild, so all three are read, in that order.
 */
export function activeAgentType(
  session:
    | { type?: string | null; agentType?: string | null; mode?: string | null }
    | null
    | undefined,
): string | null {
  if (!session) return null;
  return session.type ?? session.agentType ?? session.mode ?? null;
}

/** `LIVE · BUILD` — U+00B7 separator, agent action uppercased. */
export function liveStampLabel(agentType: string | null): string {
  return `LIVE · ${(agentType ?? "agent").toUpperCase()}`;
}

const ARIJ_ACTION_TIMELINE_KIND: Record<string, TimelineKind> = {
  tool_call: "command",
  status_change: "done",
  artifact: "done",
  comment: "summary",
  question: "summary",
  findings: "summary",
};

/**
 * Map a session's recorded board effects onto the timeline's line grammar.
 * Unknown kinds read as summaries — the line you actually read — rather than
 * being dropped, so a new action kind is visible before it is styled.
 */
export function timelineKindForAction(kind: string): TimelineKind {
  return ARIJ_ACTION_TIMELINE_KIND[kind] ?? "summary";
}

/**
 * One line of WHAT THE AGENT IS DOING, from either source that feeds it: the
 * latest session's recorded board effects, or the ticket's transition log.
 *
 * `at` exists only to interleave the two — it is never rendered. `group` is a
 * collapsed burst of automatic transitions, revealed in place rather than
 * dropped, so a heavy pipeline run does not bury the lines around it.
 */
export interface TimelineLineItem {
  key: string;
  kind: TimelineKind;
  text: string;
  at: string | null;
  group?: string[];
}

const ACTIVITY_ACTOR_WORD: Record<string, string> = {
  user: "you",
  agent: "agent",
  system: "system",
};

function columnLabel(status: string): string {
  return (COLUMN_LABELS as Record<string, string>)[status] ?? status;
}

/** `you · Review → To Merge`, with the recorded reason when there is one. */
function transitionText(entry: EpicActivityEntry): string {
  const actor = ACTIVITY_ACTOR_WORD[entry.actor] ?? entry.actor;
  // U+2192 RIGHTWARDS ARROW — the system's move glyph, never "->".
  const move = `${columnLabel(entry.fromStatus)} → ${columnLabel(entry.toStatus)}`;
  const reason = entry.reason?.trim();
  return reason ? `${actor} · ${move} — ${reason}` : `${actor} · ${move}`;
}

/**
 * Turn a built activity feed into timeline lines.
 *
 * COMMENTS ARE DROPPED. The overlay builds the feed with an empty comment
 * list on purpose — the CONVERSATION band already renders every comment, and
 * echoing them here would print each reply twice on one screen. The guard
 * stays anyway: `buildActivityFeed` is shared, and a future caller passing
 * comments must not silently duplicate them into the timeline.
 */
export function activityTimelineLines(feed: FeedItem[]): TimelineLineItem[] {
  const lines: TimelineLineItem[] = [];

  feed.forEach((item, index) => {
    if (item.kind === "comment") return;

    if (item.kind === "transition-group") {
      lines.push({
        key: `activity-group-${index}`,
        kind: "summary",
        text: `${item.entries.length} automatic transitions`,
        at: item.ts || null,
        group: item.entries.map(transitionText),
      });
      return;
    }

    if (item.kind === "pipeline") {
      lines.push({
        key: `activity-${item.entry.id}`,
        kind: "summary",
        text: item.entry.reason?.trim() || "Pipeline event",
        at: item.entry.createdAt,
      });
      return;
    }

    if (item.kind === "bug-created") {
      const detail = item.entry.reason
        ?.slice(MCP_CREATE_BUG_ACTIVITY_PREFIX.length)
        .trim();
      lines.push({
        key: `activity-${item.entry.id}`,
        kind: "summary",
        text: detail
          ? `agent created this bug — ${detail}`
          : "agent created this bug",
        at: item.entry.createdAt,
      });
      return;
    }

    lines.push({
      key: `activity-${item.entry.id}`,
      kind: "done",
      text: transitionText(item.entry),
      at: item.entry.createdAt,
    });
  });

  return lines;
}

/**
 * Interleave two already-chronological line lists into one.
 *
 * Both sources carry nullable timestamps (`arijActions[].at` is nullable, and
 * so is a transition row's `created_at`). An undated line INHERITS the last
 * dated line of its own list instead of sorting to the front, so a missing
 * clock never reorders a list against itself; ties go to the left list, which
 * keeps the merge stable and makes it a pure function of the two inputs.
 */
export function mergeTimelineLines<T extends { at: string | null }>(
  left: T[],
  right: T[],
): T[] {
  const stamped = (list: T[]) => {
    let last = Number.NEGATIVE_INFINITY;
    return list.map((item) => {
      const parsed = item.at ? Date.parse(item.at) : Number.NaN;
      if (!Number.isNaN(parsed)) last = parsed;
      return { item, ts: last };
    });
  };

  const a = stamped(left);
  const b = stamped(right);
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].ts <= b[j].ts) out.push(a[i++].item);
    else out.push(b[j++].item);
  }
  while (i < a.length) out.push(a[i++].item);
  while (j < b.length) out.push(b[j++].item);
  return out;
}

/* ------------------------------------------------------------------ */
/* Description meta line                                               */
/* ------------------------------------------------------------------ */

/**
 * `priority high · created 2d ago · from GH #412`.
 *
 * The frame's third segment is a provenance ("by chat brainstorm") that no
 * column carries, and none is being invented: the GitHub issue number is the
 * one true provenance in the schema, and it fills that slot only when it is
 * set. A missing `createdAt` drops its segment rather than printing a dash —
 * an absent relative time reads worse as "—" than as nothing.
 */
export function descriptionMeta(epic: {
  priority?: number | null;
  createdAt?: string | null;
  githubIssueNumber?: number | null;
}): string {
  const segments: string[] = [];

  const priorityLabel =
    typeof epic.priority === "number" ? PRIORITY_LABELS[epic.priority] : undefined;
  if (priorityLabel) segments.push(`priority ${priorityLabel.toLowerCase()}`);

  const created = epic.createdAt ? timeAgo(epic.createdAt) : "";
  if (created) segments.push(`created ${created}`);

  if (typeof epic.githubIssueNumber === "number") {
    segments.push(`from GH #${epic.githubIssueNumber}`);
  }

  return segments.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Re-exports for callers that only import this module                 */
/* ------------------------------------------------------------------ */

export type { ProjectTone };
