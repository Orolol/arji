/**
 * Ticket activity feed — autonomous pipeline trace entries (pure).
 *
 * Pipeline entries are `system` transitions with fromStatus === toStatus, so
 * without special handling they would be swallowed by the "N automatic
 * transitions" collapsing. These tests pin that they stay their own kind.
 *
 * The row-rendering cases went with `EpicActivityFeed` when frame 6a replaced
 * the three-tab ticket panel; the logic they exercised lives on in
 * `lib/kanban/activity-feed.ts`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildActivityFeed } from "@/lib/kanban/activity-feed";
import type { EpicActivityEntry } from "@/hooks/useEpicActivity";
import { PIPELINE_REASONS } from "@/lib/pipeline/constants";

let seq = 0;
function pipelineEntry(
  reason: string,
  overrides: Partial<EpicActivityEntry> = {}
): EpicActivityEntry {
  seq += 1;
  return {
    id: `p${seq}`,
    projectId: "proj-1",
    epicId: "epic-1",
    fromStatus: "in_progress",
    toStatus: "in_progress",
    actor: "system",
    reason,
    sessionId: `sess-${seq}`,
    createdAt: new Date(2026, 0, 1, 10, seq).toISOString(),
    ...overrides,
  };
}

function plainSystemEntry(overrides: Partial<EpicActivityEntry> = {}): EpicActivityEntry {
  seq += 1;
  return {
    id: `s${seq}`,
    projectId: "proj-1",
    epicId: "epic-1",
    fromStatus: "in_progress",
    toStatus: "review",
    actor: "system",
    reason: "Agent finished the build",
    sessionId: null,
    createdAt: new Date(2026, 0, 1, 10, seq).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  seq = 0;
});

describe("buildActivityFeed — pipeline entries", () => {
  it("splits pipeline entries out of the system-transition grouping", () => {
    const entries = [
      pipelineEntry(PIPELINE_REASONS.started),
      pipelineEntry(PIPELINE_REASONS.reviewStarted),
      pipelineEntry(PIPELINE_REASONS.finished),
    ];

    const feed = buildActivityFeed([], entries);

    expect(feed.map((i) => i.kind)).toEqual(["pipeline", "pipeline", "pipeline"]);
  });

  it("still groups ordinary consecutive system transitions", () => {
    const entries = [plainSystemEntry(), plainSystemEntry()];
    const feed = buildActivityFeed([], entries);
    expect(feed.map((i) => i.kind)).toEqual(["transition-group"]);
  });

  it("breaks a grouping run when a pipeline entry lands between system ones", () => {
    const entries = [
      plainSystemEntry(),
      pipelineEntry(PIPELINE_REASONS.reviewStarted),
      plainSystemEntry(),
    ];
    const feed = buildActivityFeed([], entries);
    expect(feed.map((i) => i.kind)).toEqual([
      "transition",
      "pipeline",
      "transition",
    ]);
  });
});
