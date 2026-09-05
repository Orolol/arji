/** Minimal payloads for the surfaces exercised by `toast-surface-uniformity`. */

import type { QaPayload } from "@/lib/qa/types";

export function qaPayload(): QaPayload {
  return {
    generatedAt: new Date().toISOString(),
    projects: [
      {
        id: "p1",
        name: "Arij",
        shortName: "ARIJ",
        colorIndex: 0,
        activeAgents: 0,
        autoModeEnabled: false,
      },
    ],
    runs: [],
    queued: [],
    findings: [
      {
        findingId: "f1",
        epicId: "e1",
        projectId: "p1",
        readableId: "ARJ-113",
        ticketTitle: "Named agents",
        text: "Le token MCP est loggé en clair",
        filePath: "lib/agents/session.ts",
        lineNumber: 214,
        severity: "critical",
        severityLabel: "BLOCKING",
        tier: "blocking",
        blocking: true,
        reviewer: "Security CC",
        reviewerAgentType: "review_security",
        filedAt: new Date().toISOString(),
        fixable: true,
        rawBody: "[critical] Le token MCP est loggé en clair",
      },
    ],
    verdicts: [],
    rubric: { items: ["Tests"], projectRuleCount: 0 },
    reviewable: [],
    coveragePercent: 92,
  };
}

export function releaseProject(): Record<string, unknown> {
  return {
    id: "p1",
    name: "Arij",
    defaultBranch: "main",
    gitRepoPath: "/repo",
    githubOwnerRepo: "orolol/arij",
  };
}

export function releaseEpics(): Record<string, unknown>[] {
  return [
    {
      id: "e1",
      title: "Project rail: breathing dots per project",
      status: "done",
      type: "feature",
      readableId: "ARJ-107",
      releaseId: null,
      usCount: 2,
      usDone: 2,
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    },
  ];
}
