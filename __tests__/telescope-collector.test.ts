import { afterEach, describe, expect, it } from "vitest";
import type { ArijDatabase } from "@/lib/db";
import { createTestDb } from "@/lib/db/test-utils";
import {
  agentSessionChunks,
  agentSessions,
  epics,
  projects,
  reviewComments,
  ticketComments,
} from "@/lib/db/schema";
import {
  buildFailureSignature,
  collectFailureDigestEvidence,
  normalizeFindingMessagePrefix,
  TELESCOPE_MAX_PAYLOAD_CHARS,
} from "@/lib/telescope/collect";
import {
  FORENSIC_COMMENT_HEADING,
  forensicDeadSessionMarker,
} from "@/lib/pipeline/forensic";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

const openDatabases: ReturnType<typeof createTestDb>[] = [];

function testDatabase() {
  const created = createTestDb();
  openDatabases.push(created);
  return created;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()!.sqlite.close();
});

function seedProject(
  database: ArijDatabase,
  projectId: string,
  epicId: string = `${projectId}-epic`
) {
  database.insert(projects).values({ id: projectId, name: projectId }).run();
  database
    .insert(epics)
    .values({ id: epicId, projectId, title: epicId, status: "in_progress" })
    .run();
  return epicId;
}

let sessionNumber = 0;

function seedSession(
  database: ArijDatabase,
  input: {
    projectId: string;
    epicId?: string | null;
    at?: string;
    status?: string;
    outcome?: string | null;
    provider?: string;
    agentType?: string;
    error?: string | null;
    lastNonEmptyText?: string | null;
  }
) {
  sessionNumber += 1;
  const id = `telescope-session-${sessionNumber}`;
  const at = input.at ?? daysAgo(1);
  database
    .insert(agentSessions)
    .values({
      id,
      projectId: input.projectId,
      epicId: input.epicId ?? null,
      status: input.status ?? "failed",
      outcome: input.outcome === undefined ? "error" : input.outcome,
      provider: input.provider ?? "claude-code",
      agentType: input.agentType ?? "ticket_build",
      error: input.error ?? "Command failed",
      lastNonEmptyText: input.lastNonEmptyText ?? null,
      createdAt: at,
      startedAt: at,
      endedAt: at,
      completedAt: at,
    })
    .run();
  return id;
}

function seedChunk(
  database: ArijDatabase,
  sessionId: string,
  sequence: number,
  content: string,
  streamType = "raw"
) {
  database
    .insert(agentSessionChunks)
    .values({
      id: `${sessionId}-chunk-${sequence}`,
      sessionId,
      streamType,
      sequence,
      content,
      createdAt: daysAgo(1),
    })
    .run();
}

describe("collectFailureDigestEvidence — window and session sources", () => {
  it("returns an empty bounded payload when the window has no evidence", () => {
    const { db } = testDatabase();
    seedProject(db, "project-empty");

    const result = collectFailureDigestEvidence("project-empty", {
      now: NOW,
      database: db,
    });

    expect(result).toMatchObject({
      evidenceCount: 0,
      groupCount: 0,
      groups: [],
      omittedGroupCount: 0,
      payloadChars: 2,
      truncated: false,
    });
  });

  it("uses a 14-day default, accepts a custom window, and stays project-scoped", () => {
    const { db } = testDatabase();
    const epicId = seedProject(db, "project-window");
    const otherEpicId = seedProject(db, "project-other");

    const recent = seedSession(db, {
      projectId: "project-window",
      epicId,
      at: daysAgo(2),
      error: "Recent failure",
    });
    seedSession(db, {
      projectId: "project-window",
      epicId,
      at: daysAgo(10),
      error: "Ten-day failure",
    });
    seedSession(db, {
      projectId: "project-window",
      epicId,
      at: daysAgo(15),
      error: "Too old",
    });
    seedSession(db, {
      projectId: "project-other",
      epicId: otherEpicId,
      at: daysAgo(1),
      error: "Other project",
    });
    seedChunk(db, recent, 1, "first chunk");
    seedChunk(db, recent, 2, "LAST FAILURE CHUNK", "output");

    const defaultWindow = collectFailureDigestEvidence("project-window", {
      now: NOW,
      database: db,
    });
    expect(defaultWindow.windowDays).toBe(14);
    expect(defaultWindow.sinceIso).toBe(daysAgo(14));
    expect(defaultWindow.evidenceCount).toBe(2);
    expect(
      defaultWindow.groups.flatMap((group) => group.examples).find(
        (item) => item.sessionId === recent
      )?.lastChunk
    ).toMatchObject({
      sequence: 2,
      streamType: "output",
      content: "LAST FAILURE CHUNK",
    });

    const sevenDays = collectFailureDigestEvidence("project-window", {
      now: NOW,
      windowDays: 7,
      database: db,
    });
    expect(sevenDays.sinceIso).toBe(daysAgo(7));
    expect(sevenDays.evidenceCount).toBe(1);
  });

  it("collects failed, silent, and transition-refused outcomes with their details", () => {
    const { db } = testDatabase();
    const epicId = seedProject(db, "project-sources");
    const failed = seedSession(db, {
      projectId: "project-sources",
      epicId,
      error: "Compiler crashed",
    });
    const silent = seedSession(db, {
      projectId: "project-sources",
      epicId,
      status: "completed",
      outcome: "silent",
      error: null,
      lastNonEmptyText: null,
    });
    const refused = seedSession(db, {
      projectId: "project-sources",
      epicId,
      status: "completed",
      outcome: "transition_refused",
      error: "Story is owned by another running session",
    });
    seedChunk(db, silent, 1, "provider emitted no final response");

    const result = collectFailureDigestEvidence("project-sources", {
      now: NOW,
      database: db,
    });
    const examples = result.groups.flatMap((group) => group.examples);

    expect(examples.find((item) => item.sessionId === failed)).toMatchObject({
      source: "session_failure",
      status: "failed",
      outcome: "error",
      error: "Compiler crashed",
    });
    expect(examples.find((item) => item.sessionId === silent)).toMatchObject({
      source: "session_failure",
      status: "completed",
      outcome: "silent",
      lastChunk: { content: "provider emitted no final response" },
    });
    expect(examples.find((item) => item.sessionId === refused)).toMatchObject({
      source: "transition_refused",
      reason: "Story is owned by another running session",
    });
  });
});

describe("mechanical signatures", () => {
  it("normalizes provider/type and run-specific ids, paths, lines, and numbers", () => {
    const first = buildFailureSignature({
      provider: " Claude-Code ",
      agentType: "Ticket Build",
      motif:
        "Error 137 at /tmp/arij/run-a/output.ts:42 for 123e4567-e89b-12d3-a456-426614174000",
    });
    const second = buildFailureSignature({
      provider: "claude-code",
      agentType: "ticket_build",
      motif:
        "Error 9 at /tmp/arij/run-b/output.ts:88 for 123e4567-e89b-12d3-a456-426614174999",
    });

    expect(first.signature).toBe(second.signature);
    expect(first.provider).toBe("claude-code");
    expect(first.agentType).toBe("ticket_build");
    expect(first.motif).toContain("<path>");
    expect(first.motif).toContain("<n>");
  });

  it("groups equal motifs but keeps providers and agent types separate", () => {
    const { db } = testDatabase();
    const epicId = seedProject(db, "project-signatures");
    for (const [provider, agentType, code] of [
      ["claude-code", "ticket_build", "101"],
      ["claude-code", "ticket_build", "202"],
      ["codex", "ticket_build", "303"],
      ["claude-code", "review_code", "404"],
    ] as const) {
      seedSession(db, {
        projectId: "project-signatures",
        epicId,
        provider,
        agentType,
        error: `Worker ${code} failed at /tmp/runs/${code}/trace.log:55`,
      });
    }

    const result = collectFailureDigestEvidence("project-signatures", {
      now: NOW,
      database: db,
    });
    expect(result.groupCount).toBe(3);
    expect(result.groups.map((group) => group.count).sort()).toEqual([1, 1, 2]);
    expect(result.groups[0]).toMatchObject({
      provider: "claude-code",
      agentType: "ticket_build",
      count: 2,
    });
  });
});

describe("forensic reports and recurring findings", () => {
  it("collects forensic diagnostics and only recurrent critical/major findings", () => {
    const { db } = testDatabase();
    const epicId = seedProject(db, "project-enrichment");
    const forensicSession = seedSession(db, {
      projectId: "project-enrichment",
      epicId: null,
      status: "completed",
      outcome: "answered",
      provider: "codex",
      agentType: "forensic",
      error: null,
    });
    const deadSession = seedSession(db, {
      projectId: "project-enrichment",
      epicId,
      error: "Dead build",
    });
    db.insert(ticketComments)
      .values({
        id: "forensic-comment",
        epicId,
        author: "agent",
        agentSessionId: forensicSession,
        content: `${FORENSIC_COMMENT_HEADING}\n${forensicDeadSessionMarker(deadSession)}\n\nRoot cause: flaky package mirror`,
        createdAt: daysAgo(1),
      })
      .run();

    const reviewSession = seedSession(db, {
      projectId: "project-enrichment",
      epicId,
      status: "completed",
      outcome: "answered",
      provider: "claude-code",
      agentType: "review_code",
      error: null,
    });
    const findings: Array<{
      id: string;
      filePath: string;
      body: string;
      at?: string;
    }> = [
      {
        id: "same-file-1",
        filePath: "lib/auth.ts",
        body: "[critical] Missing authorization on the update handler",
      },
      {
        id: "same-file-2",
        filePath: "./LIB/auth.ts",
        body: "[major] A race can overwrite the token",
      },
      {
        id: "same-prefix-1",
        filePath: "lib/one.ts",
        body: "[major] Dependency cycle detected: alpha branch",
      },
      {
        id: "same-prefix-2",
        filePath: "lib/two.ts",
        body: "[critical] Dependency cycle detected: beta branch",
      },
      {
        id: "unique-major",
        filePath: "lib/unique.ts",
        body: "[major] This appears only once",
      },
      {
        id: "minor",
        filePath: "lib/auth.ts",
        body: "[minor] Cosmetic naming issue",
      },
      {
        id: "old-major",
        filePath: "lib/auth.ts",
        body: "[critical] Old issue outside the window",
        at: daysAgo(20),
      },
    ];
    for (const finding of findings) {
      db.insert(reviewComments)
        .values({
          id: finding.id,
          epicId,
          filePath: finding.filePath,
          lineNumber: 10,
          body: finding.body,
          author: "agent",
          status: finding.id === "same-file-2" ? "resolved" : "open",
          agentSessionId: reviewSession,
          createdAt: finding.at ?? daysAgo(1),
          updatedAt: finding.at ?? daysAgo(1),
        })
        .run();
    }

    expect(normalizeFindingMessagePrefix("Dependency cycle detected: alpha")).toBe(
      normalizeFindingMessagePrefix("Dependency cycle detected: beta")
    );

    const result = collectFailureDigestEvidence("project-enrichment", {
      now: NOW,
      database: db,
    });
    const examples = result.groups.flatMap((group) => group.examples);
    const forensic = examples.find((item) => item.source === "forensic");
    expect(forensic).toMatchObject({
      sessionId: forensicSession,
      relatedSessionId: deadSession,
      provider: "codex",
      agentType: "forensic",
      message: "Root cause: flaky package mirror",
    });

    const collectedFindingIds = examples
      .filter((item) => item.source === "finding")
      .map((item) => item.id)
      .sort();
    expect(collectedFindingIds).toEqual([
      "finding:same-file-1",
      "finding:same-file-2",
      "finding:same-prefix-1",
      "finding:same-prefix-2",
    ]);
    expect(
      result.groups.filter((group) => group.sourceCounts.finding > 0)
    ).toHaveLength(2);
  });
});

describe("pre-LLM volume bounds", () => {
  it("caps groups, examples, ticket ids, and evidence text after grouping", () => {
    const { db } = testDatabase();
    db.insert(projects).values({ id: "project-bounds", name: "Bounds" }).run();

    const frequencies = [4, 3, 2, 1];
    for (let groupIndex = 0; groupIndex < frequencies.length; groupIndex += 1) {
      for (let itemIndex = 0; itemIndex < frequencies[groupIndex]; itemIndex += 1) {
        const epicId = `bounded-epic-${groupIndex}-${itemIndex}`;
        db.insert(epics)
          .values({
            id: epicId,
            projectId: "project-bounds",
            title: epicId,
          })
          .run();
        const sessionId = seedSession(db, {
          projectId: "project-bounds",
          epicId,
          error: `Failure family ${String.fromCharCode(65 + groupIndex)} occurrence ${itemIndex}`,
        });
        seedChunk(db, sessionId, 1, "x".repeat(100));
      }
    }

    const result = collectFailureDigestEvidence("project-bounds", {
      now: NOW,
      database: db,
      maxGroups: 2,
      maxExamplesPerGroup: 1,
      maxTicketIdsPerGroup: 1,
      maxTextChars: 12,
      maxLastChunkChars: 7,
    });

    expect(result.evidenceCount).toBe(10);
    expect(result.groupCount).toBe(4);
    expect(result.groups).toHaveLength(2);
    expect(result.omittedGroupCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.payloadChars).toBe(JSON.stringify(result.groups).length);
    expect(result.payloadChars).toBeLessThanOrEqual(
      TELESCOPE_MAX_PAYLOAD_CHARS
    );
    expect(result.groups.map((group) => group.count)).toEqual([4, 3]);
    for (const group of result.groups) {
      expect(group.examples).toHaveLength(1);
      expect(group.ticketIds).toHaveLength(1);
      expect(group.omittedExampleCount).toBe(group.count - 1);
      expect(group.examples[0].message.length).toBeLessThanOrEqual(12);
      expect(group.examples[0].lastChunk?.content).toHaveLength(7);
    }

    const payloadBound = collectFailureDigestEvidence("project-bounds", {
      now: NOW,
      database: db,
      maxPayloadChars: 2_000,
    });
    expect(payloadBound.payloadChars).toBeLessThanOrEqual(2_000);
    expect(payloadBound.truncated).toBe(true);
  });
});
