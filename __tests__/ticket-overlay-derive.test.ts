import { COLUMN_LABEL_KEYS, PRIORITY_LABEL_KEYS } from "@/lib/types/kanban";
import { catalogueValue } from "@/lib/i18n/catalogue";
import { translatorFor } from "@/lib/i18n/translator";
import type { TicketDerivedCopy } from "@/components/ticket/copy";
/**
 * Pure derivations behind the frame-6a ticket overlay.
 *
 * Everything here is a function of data the overlay already has, so these are
 * the cheapest tests in the packet and the ones that pin the design's data
 * rules: em-dashes instead of zeros, no motion without a live session, and no
 * fabricated provenance.
 */
import { describe, it, expect } from "vitest";

import {
  activityTimelineLines,
  countAcceptanceCriteria,
  dependencyOptions,
  dependencyRowItems,
  descriptionMeta,
  diffTotals,
  hashString,
  liveStampLabel,
  mergeTimelineLines,
  pipelineSteps,
  projectToneIndex,
  shortId,
  ticketLabel,
  timelineKindForAction,
  toggledWaitsOn,
  UNKNOWN_DIFF_TOTALS,
  type EpicIndexEntry,
} from "@/components/ticket/derive";
import type { EpicActivityEntry } from "@/hooks/useEpicActivity";
import { buildActivityFeed } from "@/lib/kanban/activity-feed";
import { MCP_CREATE_BUG_ACTIVITY_PREFIX } from "@/lib/mcp/create-bug-contract";
import { projectTone } from "@/lib/piscine/tokens";

describe("countAcceptanceCriteria", () => {
  it("counts non-empty lines and treats absence as zero", () => {
    expect(countAcceptanceCriteria(null)).toBe(0);
    expect(countAcceptanceCriteria("")).toBe(0);
    expect(countAcceptanceCriteria("   \n\t\n")).toBe(0);
    expect(countAcceptanceCriteria("a\n\nb\n  \nc")).toBe(3);
  });
});

describe("pipelineSteps", () => {
  const labels = ["SPEC", "BUILD", "REVIEW", "LAND"];

  it("labels the four steps in order", () => {
    expect(pipelineSteps("backlog", false).map((s) => s.label)).toEqual(labels);
  });

  it("marks everything done once the ticket is released", () => {
    expect(pipelineSteps("released", false).map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("walks the chain column by column", () => {
    expect(pipelineSteps("backlog", false).map((s) => s.state)).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(pipelineSteps("in_progress", false).map((s) => s.state)).toEqual([
      "done",
      "pending",
      "pending",
      "pending",
    ]);
    expect(pipelineSteps("review", false).map((s) => s.state)).toEqual([
      "done",
      "done",
      "pending",
      "pending",
    ]);
    expect(pipelineSteps("to_merge", false).map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "pending",
    ]);
    expect(pipelineSteps("done", false).map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("never breathes a step while no session is running", () => {
    for (const status of [
      "backlog",
      "todo",
      "in_progress",
      "review",
      "to_merge",
      "done",
      "released",
    ]) {
      const states = pipelineSteps(status, false).map((s) => s.state);
      expect(states).not.toContain("live");
    }
  });

  it("breathes exactly the column the running session belongs to", () => {
    expect(pipelineSteps("backlog", true).map((s) => s.state)).toEqual([
      "live",
      "pending",
      "pending",
      "pending",
    ]);
    expect(pipelineSteps("in_progress", true).map((s) => s.state)).toEqual([
      "done",
      "live",
      "pending",
      "pending",
    ]);
    expect(pipelineSteps("review", true).map((s) => s.state)).toEqual([
      "done",
      "done",
      "live",
      "pending",
    ]);
    expect(pipelineSteps("to_merge", true).map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "live",
    ]);
    // `todo` has no step of its own: a running session there breathes nothing.
    expect(pipelineSteps("todo", true).map((s) => s.state)).not.toContain("live");
  });
});

describe("diffTotals", () => {
  const fixture = {
    files: [
      {
        hunks: [
          {
            lines: [
              { type: "add" },
              { type: "add" },
              { type: "del" },
              { type: "context" },
            ],
          },
          { lines: [{ type: "add" }] },
        ],
      },
      { hunks: [{ lines: [{ type: "del" }, { type: "del" }] }] },
    ],
  };

  it("sums adds and dels across every hunk of every file", () => {
    expect(diffTotals(fixture)).toEqual({ added: 3, removed: 3, files: 2 });
  });

  it("is unavailable — not zero — before the fetch resolves or when it fails", () => {
    expect(diffTotals(null)).toEqual(UNKNOWN_DIFF_TOTALS);
    expect(diffTotals(undefined)).toEqual(UNKNOWN_DIFF_TOTALS);
    expect(diffTotals({})).toEqual(UNKNOWN_DIFF_TOTALS);
    expect(UNKNOWN_DIFF_TOTALS).toEqual({
      added: null,
      removed: null,
      files: null,
    });
  });

  it("reports a genuinely empty diff as zeros, not as unavailable", () => {
    expect(diffTotals({ files: [] })).toEqual({
      added: 0,
      removed: 0,
      files: 0,
    });
  });
});

describe("dependencyRowItems", () => {
  const index: ReadonlyMap<string, EpicIndexEntry> = new Map([
    ["e-131", { readableId: "ARJ-131", title: "Inline review findings" }],
    ["e-140", { readableId: null, title: "  " }],
  ]);

  it("reads ticketId for BLOCKS and dependsOnTicketId for WAITS ON", () => {
    const records = [{ ticketId: "e-131", dependsOnTicketId: "e-140" }];

    expect(dependencyRowItems(records, "ticketId", index)[0].label).toBe(
      "ARJ-131",
    );
    expect(
      dependencyRowItems(records, "dependsOnTicketId", index)[0].id,
    ).toBe("e-140");
  });

  it("keeps the chip and drops the title for an unresolvable id", () => {
    const items = dependencyRowItems(
      [{ ticketId: "abcdef123456", dependsOnTicketId: "x" }],
      "ticketId",
      index,
    );
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("123456");
    expect(items[0].title).toBeNull();
  });

  it("drops a blank title rather than rendering whitespace", () => {
    const items = dependencyRowItems(
      [{ ticketId: "e-140", dependsOnTicketId: "x" }],
      "ticketId",
      index,
    );
    expect(items[0].title).toBeNull();
  });

  it("yields nothing for an empty relation, so the row can show its em-dash", () => {
    expect(dependencyRowItems([], "ticketId", index)).toEqual([]);
  });

  it("de-duplicates repeated edges", () => {
    const items = dependencyRowItems(
      [
        { ticketId: "e-131", dependsOnTicketId: "a" },
        { ticketId: "e-131", dependsOnTicketId: "b" },
      ],
      "ticketId",
      index,
    );
    expect(items).toHaveLength(1);
  });
});

describe("project tone fallback", () => {
  it("hashes stably for the same id", () => {
    expect(hashString("proj-1")).toBe(hashString("proj-1"));
    expect(hashString("proj-1")).not.toBe(hashString("proj-2"));
  });

  it("always lands inside the four-tone palette", () => {
    for (const id of ["a", "proj-1", "arij", "", "zzzzzzzzzzzzzzzz"]) {
      const tone = projectTone(projectToneIndex(id));
      expect([1, 2, 3, 4]).toContain(tone);
    }
  });

  it("prefers a stored colour index once the column exists", () => {
    expect(projectToneIndex("proj-1", 2)).toBe(2);
    expect(projectToneIndex("proj-1", null)).toBe(hashString("proj-1"));
  });
});

describe("ticket identity", () => {
  it("falls back to the id tail when readableId is missing", () => {
    expect(ticketLabel("ARJ-122", "abcdef123456")).toBe("ARJ-122");
    expect(ticketLabel(null, "abcdef123456")).toBe("123456");
    expect(ticketLabel("   ", "abcdef123456")).toBe("123456");
    expect(shortId("abc")).toBe("abc");
  });
});

describe("session derivations", () => {
  it("uppercases the agent action into the LIVE stamp", () => {
    expect(liveStampLabel("build")).toBe("LIVE · BUILD");
    expect(liveStampLabel(null)).toBe("LIVE · AGENT");
  });

  it("maps recorded board effects onto the timeline's line grammar", () => {
    expect(timelineKindForAction("tool_call")).toBe("command");
    expect(timelineKindForAction("status_change")).toBe("done");
    expect(timelineKindForAction("artifact")).toBe("done");
    expect(timelineKindForAction("comment")).toBe("summary");
    expect(timelineKindForAction("question")).toBe("summary");
    expect(timelineKindForAction("findings")).toBe("summary");
    // An unknown kind stays visible rather than being dropped.
    expect(timelineKindForAction("brand_new_kind")).toBe("summary");
  });
});

describe("descriptionMeta", () => {
  it("builds priority and created from the columns that exist", () => {
    const meta = descriptionMeta(
      {
        priority: 2,
        createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      },
      "en", copy
    );
    expect(meta).toBe("priority high · created 2d ago");
  });

  it("adds the GitHub issue only when the column is set", () => {
    expect(
      descriptionMeta({ priority: 1, createdAt: null, githubIssueNumber: 412 }, "en", copy),
    ).toBe("priority medium · from GH #412");
    expect(descriptionMeta({ priority: 1, createdAt: null }, "en", copy)).toBe(
      "priority medium",
    );
  });

  it("drops the created segment rather than printing a dash for it", () => {
    expect(descriptionMeta({ priority: 0, createdAt: null }, "en", copy)).toBe(
      "priority low",
    );
  });
});

/* ------------------------------------------------------------------ */
/* Dependency editing                                                  */
/* ------------------------------------------------------------------ */

describe("dependencyOptions", () => {
  const rows = [
    { id: "epic-1", readableId: "ARJ-1", title: "Self" },
    { id: "epic-2", readableId: "ARJ-2", title: "Streaming logs" },
    { id: "epic-3", readableId: null, title: "   " },
  ];

  it("offers every other ticket, never the ticket itself", () => {
    const options = dependencyOptions(rows, "epic-1", []);
    expect(options.map((option) => option.id)).toEqual(["epic-2", "epic-3"]);
  });

  it("marks the ones already waited on", () => {
    const options = dependencyOptions(rows, "epic-1", ["epic-3"]);
    expect(options.find((o) => o.id === "epic-2")?.selected).toBe(false);
    expect(options.find((o) => o.id === "epic-3")?.selected).toBe(true);
  });

  it("falls back to the id tail and drops a blank title", () => {
    const [, third] = dependencyOptions(rows, "epic-1", []);
    expect(third.label).toBe("epic-3");
    // A whitespace-only title is nothing to render, not an empty string.
    expect(third.title).toBeNull();
  });
});

describe("toggledWaitsOn", () => {
  it("adds at the end and removes in place", () => {
    expect(toggledWaitsOn(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggledWaitsOn(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("never mutates its input", () => {
    const ids = ["a"];
    toggledWaitsOn(ids, "b");
    expect(ids).toEqual(["a"]);
  });
});

/* ------------------------------------------------------------------ */
/* Activity → timeline                                                 */
/* ------------------------------------------------------------------ */

function activity(
  overrides: Partial<EpicActivityEntry> & { id: string },
): EpicActivityEntry {
  return {
    projectId: "proj-1",
    epicId: "epic-1",
    fromStatus: "review",
    toStatus: "to_merge",
    actor: "user",
    reason: null,
    sessionId: null,
    createdAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
}

describe("activityTimelineLines", () => {
  it("reads a transition as a completed step, in board labels", () => {
    const [line] = activityTimelineLines(
      buildActivityFeed([], [activity({ id: "a1" })]), copy
    );
    expect(line.kind).toBe("done");
    expect(line.text).toBe("you · Review → To Merge");
    expect(line.at).toBe("2026-08-28T10:00:00.000Z");
  });

  it("appends the recorded reason when there is one", () => {
    const [line] = activityTimelineLines(
      buildActivityFeed([], [activity({ id: "a1", reason: "review passed" })]), copy
    );
    expect(line.text).toBe("you · Review → To Merge — review passed");
  });

  it("renders pipeline narration as its own summary line, not a status move", () => {
    const [line] = activityTimelineLines(
      buildActivityFeed(
        [],
        [
          activity({
            id: "a1",
            actor: "system",
            fromStatus: "in_progress",
            toStatus: "in_progress",
            reason: "Pipeline finished: everything green",
          }),
        ],
      ), copy
    );
    expect(line.kind).toBe("summary");
    expect(line.text).toBe("Pipeline finished: everything green");
  });

  it("names the bug an agent filed, carrying its detail", () => {
    const [line] = activityTimelineLines(
      buildActivityFeed(
        [],
        [
          activity({
            id: "a1",
            actor: "agent",
            reason: `${MCP_CREATE_BUG_ACTIVITY_PREFIX} reported from ARJ-9`,
          }),
        ],
      ), copy
    );
    expect(line.text).toBe("agent created this bug — reported from ARJ-9");
  });

  it("collapses a burst of automatic transitions and keeps every line inside it", () => {
    const burst = [
      activity({
        id: "a1",
        actor: "system",
        createdAt: "2026-08-28T10:00:00.000Z",
      }),
      activity({
        id: "a2",
        actor: "system",
        fromStatus: "to_merge",
        toStatus: "done",
        createdAt: "2026-08-28T10:00:10.000Z",
      }),
    ];
    const [line] = activityTimelineLines(buildActivityFeed([], burst), copy);
    expect(line.text).toBe("2 automatic transitions");
    expect(line.group).toEqual([
      "system · Review → To Merge",
      "system · To Merge → Done",
    ]);
  });

  it("never echoes a comment — the CONVERSATION band owns those", () => {
    const lines = activityTimelineLines(
      buildActivityFeed(
        [
          {
            id: "c1",
            author: "user",
            content: "hello",
            createdAt: "2026-08-28T09:00:00.000Z",
          } as never,
        ],
        [activity({ id: "a1" })],
      ), copy
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("you · Review → To Merge");
  });
});

describe("mergeTimelineLines", () => {
  const line = (key: string, at: string | null) => ({
    key,
    kind: "summary" as const,
    text: key,
    at,
  });

  it("interleaves two chronological lists by timestamp", () => {
    const merged = mergeTimelineLines(
      [line("t1", "2026-08-28T10:00:00.000Z"), line("t2", "2026-08-28T12:00:00.000Z")],
      [line("s1", "2026-08-28T11:00:00.000Z")],
    );
    expect(merged.map((item) => item.key)).toEqual(["t1", "s1", "t2"]);
  });

  it("anchors an undated line to the last dated line of its own list", () => {
    // s2 has no clock: it must stay after s1, not jump ahead of t1.
    const merged = mergeTimelineLines(
      [line("t1", "2026-08-28T12:00:00.000Z")],
      [line("s1", "2026-08-28T11:00:00.000Z"), line("s2", null)],
    );
    expect(merged.map((item) => item.key)).toEqual(["s1", "s2", "t1"]);
  });

  it("keeps each list's own order whatever the clocks say", () => {
    const merged = mergeTimelineLines(
      [line("t1", "2026-08-28T12:00:00.000Z"), line("t2", "2026-08-28T09:00:00.000Z")],
      [],
    );
    expect(merged.map((item) => item.key)).toEqual(["t1", "t2"]);
  });

  it("puts a tie on the left list, so the merge is stable", () => {
    const merged = mergeTimelineLines(
      [line("t1", "2026-08-28T10:00:00.000Z")],
      [line("s1", "2026-08-28T10:00:00.000Z")],
    );
    expect(merged.map((item) => item.key)).toEqual(["t1", "s1"]);
  });
});

const t = translatorFor("en", "Ticket");
const copy: TicketDerivedCopy = {
  columns: Object.fromEntries(Object.entries(COLUMN_LABEL_KEYS).map(([value, key]) => [value, catalogueValue("en", key)])),
  priorities: Object.fromEntries(Object.entries(PRIORITY_LABEL_KEYS).map(([value, key]) => [value, catalogueValue("en", key)])),
  actors: { user: t("derived.actors.user"), agent: t("derived.actors.agent"), system: t("derived.actors.system") },
  transitions: (count) => t("derived.transitions", { count }),
  pipelineEvent: t("derived.pipelineEvent"),
  bugCreated: t("derived.bugCreated"),
  bugDetail: (detail) => t("derived.bugDetail", { detail }),
  priority: (priority) => t("derived.priority", { priority }),
  created: (age) => t("derived.created", { age }),
  github: (number) => t("derived.github", { number }),
};
