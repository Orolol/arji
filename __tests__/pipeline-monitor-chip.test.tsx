/**
 * AgentMonitor — "Pipeline · <stage>" chip, fed by polling
 * GET /api/projects/[projectId]/pipeline/runs, plus the pure sessionId →
 * run index behind it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentMonitor } from "@/components/monitor/AgentMonitor";
import { AgentActionsBar } from "@/components/shared/AgentActionsBar";
import type { UnifiedActivity } from "@/hooks/useAgentPolling";
import {
  indexPipelineSessions,
  pipelineChipLabel,
} from "@/hooks/usePipelineRuns";
import type { PipelineRunSnapshot } from "@/lib/pipeline/constants";

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select" />,
}));
vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: () => <div data-testid="session-picker" />,
}));
vi.mock("@/components/documents/MentionTextarea", () => ({
  MentionTextarea: () => <textarea data-testid="mention-textarea" />,
}));

function runningActivity(id: string): UnifiedActivity {
  return {
    id,
    epicId: "epic-1",
    userStoryId: null,
    type: "build",
    label: `Building: ${id}`,
    status: "running",
    mode: "code",
    provider: "claude-code",
    startedAt: new Date().toISOString(),
    source: "db",
    cancellable: true,
  };
}

function snapshot(over: Partial<PipelineRunSnapshot> = {}): PipelineRunSnapshot {
  return {
    runId: "run-1",
    projectId: "proj-1",
    epicId: "epic-1",
    userStoryId: null,
    state: "running_review",
    stage: "review",
    stageAttempt: 1,
    fixCycles: 0,
    sessionIds: ["s1", "s2"],
    startedAt: new Date().toISOString(),
    endedAt: null,
    reason: null,
    ...over,
  };
}

/** Answers both pollers the monitor runs (waves + pipeline runs). */
function stubFetch(runs: PipelineRunSnapshot[]) {
  const fetchMock = vi.fn((url: string) => {
    if (String(url).includes("/pipeline/runs")) {
      return Promise.resolve({ json: () => Promise.resolve({ data: runs }) });
    }
    return Promise.resolve({ json: () => Promise.resolve({ data: [] }) });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("indexPipelineSessions", () => {
  it("labels the newest session of an active run with the current stage", () => {
    const index = indexPipelineSessions([snapshot()]);
    expect(index.s2.stage).toBe("review");
    expect(pipelineChipLabel(index.s2)).toBe("Pipeline · Review");
  });

  it("leaves earlier sessions of the run unqualified", () => {
    const index = indexPipelineSessions([snapshot()]);
    expect(index.s1.stage).toBeNull();
    expect(pipelineChipLabel(index.s1)).toBe("Pipeline");
  });

  it("drops the stage once the run reached a terminal state", () => {
    const index = indexPipelineSessions([
      snapshot({ state: "succeeded", stage: null }),
    ]);
    expect(index.s2.active).toBe(false);
    expect(pipelineChipLabel(index.s2)).toBe("Pipeline");
  });

  it("tolerates malformed payloads without throwing", () => {
    const junk = [
      { runId: "x" },
      null,
      snapshot({ runId: "run-2", sessionIds: [] }),
    ] as unknown as PipelineRunSnapshot[];
    expect(() => indexPipelineSessions(junk)).not.toThrow();
    expect(indexPipelineSessions(junk)).toEqual({});
  });
});

describe("AgentActionsBar pipeline chip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("explains a running session that belongs to a pipeline run", async () => {
    stubFetch([snapshot({ sessionIds: ["s1"], stage: "review" })]);

    render(
      <AgentActionsBar
        projectId="proj-1"
        target={{ kind: "epic", epic: { id: "epic-1", status: "todo", title: "E" } }}
        dispatching={false}
        isRunning
        activeSessionId="s1"
        onSendToDev={vi.fn(async () => undefined)}
        onSendToReview={vi.fn(async () => undefined)}
        onComplete={vi.fn(async () => undefined)}
      />
    );

    await waitFor(() =>
      expect(screen.getByTestId("pipeline-chip")).toHaveTextContent(
        "Pipeline · Review"
      )
    );
  });

  it("shows no chip for a hand-dispatched running session", async () => {
    stubFetch([snapshot({ sessionIds: ["other"] })]);

    render(
      <AgentActionsBar
        projectId="proj-1"
        target={{ kind: "epic", epic: { id: "epic-1", status: "todo", title: "E" } }}
        dispatching={false}
        isRunning
        activeSessionId="s1"
        onSendToDev={vi.fn(async () => undefined)}
        onSendToReview={vi.fn(async () => undefined)}
        onComplete={vi.fn(async () => undefined)}
      />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("pipeline-chip")).not.toBeInTheDocument();
  });
});

describe("AgentMonitor pipeline chip", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("badges a session owned by a running pipeline with its stage", async () => {
    stubFetch([snapshot({ sessionIds: ["s1"], stage: "fix", state: "running_fix" })]);

    render(<AgentMonitor projectId="proj-1" activities={[runningActivity("s1")]} />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-monitor-pipeline-s1")).toBeInTheDocument()
    );
    expect(screen.getByTestId("agent-monitor-pipeline-s1")).toHaveTextContent(
      "Pipeline · Fix"
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/projects/proj-1/pipeline/runs"
    );
  });

  it("leaves hand-dispatched sessions unbadged", async () => {
    stubFetch([snapshot({ sessionIds: ["other"] })]);

    render(<AgentMonitor projectId="proj-1" activities={[runningActivity("s1")]} />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(
      screen.queryByTestId("agent-monitor-pipeline-s1")
    ).not.toBeInTheDocument();
  });

  it("renders no chip when the runs endpoint fails", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch;

    render(<AgentMonitor projectId="proj-1" activities={[runningActivity("s1")]} />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(
      screen.queryByTestId("agent-monitor-pipeline-s1")
    ).not.toBeInTheDocument();
  });
});
