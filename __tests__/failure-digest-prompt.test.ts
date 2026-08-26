import { describe, expect, it } from "vitest";
import { buildFailureDigestPrompt } from "@/lib/claude/prompt-builder";
import type { TelescopeCollectionResult } from "@/lib/telescope/collect";

describe("buildFailureDigestPrompt", () => {
  it("hands the bounded mechanical groups to a plan-only markdown contract", () => {
    const collection = {
      projectId: "proj-1",
      windowDays: 14,
      sinceIso: "2026-08-11T12:00:00.000Z",
      untilIso: "2026-08-25T12:00:00.000Z",
      evidenceCount: 3,
      groupCount: 2,
      groups: [
        {
          signature: "claude-code::ticket_build::worker failed",
          provider: "claude-code",
          agentType: "ticket_build",
          motif: "worker failed",
          count: 2,
          sourceCounts: {
            session_failure: 2,
            transition_refused: 0,
            forensic: 0,
            finding: 0,
          },
          firstSeenAt: "2026-08-20T12:00:00.000Z",
          lastSeenAt: "2026-08-24T12:00:00.000Z",
          ticketCount: 2,
          ticketIds: ["epic-1", "story-2"],
          examples: [],
          omittedExampleCount: 2,
        },
      ],
      omittedGroupCount: 1,
      payloadChars: 640,
      truncated: true,
    } satisfies TelescopeCollectionResult;

    const prompt = buildFailureDigestPrompt(
      { name: "Arij", spec: "Local-first orchestrator", memory: null },
      collection,
      "Prioritize failures that stop delivery.",
      "Be conservative.",
    );

    expect(prompt).toContain("Be conservative.");
    expect(prompt).toContain("You are running in plan mode");
    expect(prompt).toContain("2026-08-11T12:00:00.000Z");
    expect(prompt).toContain('"signature": "claude-code::ticket_build::worker failed"');
    expect(prompt).toContain("exact observed frequency and source breakdown");
    expect(prompt).toContain("affected ticket IDs");
    expect(prompt).toContain("root-cause hypothesis");
    expect(prompt).toContain("proposed remediation");
    expect(prompt).toContain("Groups omitted by limits: 1");
    expect(prompt).toContain("Your ENTIRE response must be only the markdown report");
  });
});
