import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { PromptTokenEstimateView } from "@/components/shared/PromptTokenEstimateView";
import { AgentDispatchDialog } from "@/components/shared/AgentDispatchDialog";

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: [
      { id: "agent-1", name: "Claude Code", provider: "claude-code", model: "opus" },
    ],
    loading: false,
    refresh: vi.fn(),
  }),
}));

const mockEstimateData = {
  total: 14500,
  breakdown: {
    spec: 4500,
    memory: 1200,
    ticket: 2500,
    comments: 3000,
    findings: 1800,
    documents: 1500,
    system: 400,
    other: 600,
  },
  sessionsCount: 1,
  budget: 50000,
  budgetExceeded: false,
  largestSection: {
    key: "spec",
    label: "Project Specification",
    tokens: 4500,
    percentage: 31,
  },
};

const mockMultiSessionEstimateData = {
  total: 32000,
  breakdown: {
    spec: 9000,
    memory: 2400,
    ticket: 5000,
    comments: 6000,
    findings: 4600,
    documents: 3000,
    system: 800,
    other: 1200,
  },
  sessionsCount: 2,
  perSessionEstimates: [
    {
      reviewType: "security",
      tokens: 16000,
      breakdown: {
        spec: 4500,
        memory: 1200,
        ticket: 2500,
        comments: 3000,
        findings: 2300,
        documents: 1500,
        system: 400,
        other: 600,
      },
    },
    {
      reviewType: "code_review",
      tokens: 16000,
      breakdown: {
        spec: 4500,
        memory: 1200,
        ticket: 2500,
        comments: 3000,
        findings: 2300,
        documents: 1500,
        system: 400,
        other: 600,
      },
    },
  ],
  budget: 50000,
  budgetExceeded: false,
  largestSection: {
    key: "spec",
    label: "Project Specification",
    tokens: 9000,
    percentage: 28,
  },
};

const mockExceededEstimateData = {
  total: 55000,
  breakdown: {
    spec: 35000,
    memory: 2000,
    ticket: 5000,
    comments: 5000,
    findings: 4000,
    documents: 4000,
    system: 500,
    other: 500,
  },
  sessionsCount: 1,
  budget: 30000,
  budgetExceeded: true,
  largestSection: {
    key: "spec",
    label: "Project Specification",
    tokens: 35000,
    percentage: 64,
  },
};

beforeEach(() => {
  global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    const body = opts?.body ? JSON.parse(opts.body as string) : {};
    if (body.epicId === "epic-error") {
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "Internal error" }),
      });
    }
    if (body.epicId === "epic-multi") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: mockMultiSessionEstimateData }),
      });
    }
    if (body.epicId === "epic-exceeded") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: mockExceededEstimateData }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: mockEstimateData }),
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PromptTokenEstimateView", () => {
  it("renders total tokens and context section breakdown with all 8 categories", async () => {
    render(
      <PromptTokenEstimateView
        projectId="proj-1"
        epicId="epic-1"
        dispatchType="build"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("prompt-token-estimate")).toBeInTheDocument();
    });

    expect(screen.getByTestId("prompt-estimate-total")).toHaveTextContent("~14.5k tokens");
    expect(screen.getByText("Budget: 50.0k")).toBeInTheDocument();

    const breakdown = screen.getByTestId("prompt-estimate-breakdown");
    expect(breakdown).toHaveTextContent("Spec:");
    expect(breakdown).toHaveTextContent("4.5k");
    expect(breakdown).toHaveTextContent("Memory:");
    expect(breakdown).toHaveTextContent("1.2k");
    expect(breakdown).toHaveTextContent("Ticket / Stories:");
    expect(breakdown).toHaveTextContent("2.5k");
    expect(breakdown).toHaveTextContent("Comments:");
    expect(breakdown).toHaveTextContent("3.0k");
    expect(breakdown).toHaveTextContent("Findings:");
    expect(breakdown).toHaveTextContent("1.8k");
    expect(breakdown).toHaveTextContent("Documents:");
    expect(breakdown).toHaveTextContent("1.5k");
    expect(breakdown).toHaveTextContent("System:");
    expect(breakdown).toHaveTextContent("400");
    expect(breakdown).toHaveTextContent("Other / Instr:");
    expect(breakdown).toHaveTextContent("600");
  });

  it("renders multi-session summary when dispatching multiple review types", async () => {
    render(
      <PromptTokenEstimateView
        projectId="proj-1"
        epicId="epic-multi"
        dispatchType="review"
        reviewTypes={["security", "code_review"]}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("prompt-token-estimate")).toBeInTheDocument();
    });

    expect(screen.getByTestId("prompt-estimate-total")).toHaveTextContent("~32.0k tokens");
    expect(screen.getByTestId("prompt-estimate-total")).toHaveTextContent("(2 sessions)");
    const perSession = screen.getByTestId("prompt-estimate-per-session");
    expect(perSession).toHaveTextContent("Per session:");
    expect(perSession).toHaveTextContent("Security");
    expect(perSession).toHaveTextContent("Code Review");
  });

  it("renders muted notice when estimate request fails", async () => {
    render(
      <PromptTokenEstimateView
        projectId="proj-1"
        epicId="epic-error"
        dispatchType="build"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("prompt-estimate-unavailable")).toBeInTheDocument();
    });

    expect(screen.getByText("Prompt estimate unavailable")).toBeInTheDocument();
  });

  it("renders non-blocking warning when budget is exceeded and names the heaviest section", async () => {
    render(
      <PromptTokenEstimateView
        projectId="proj-1"
        epicId="epic-exceeded"
        dispatchType="build"
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("prompt-budget-warning")).toBeInTheDocument();
    });

    expect(screen.getByText(/Prompt token budget warning/i)).toBeInTheDocument();
    expect(screen.getByText(/exceeds the configured budget \(30.0k tokens\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Project Specification/i)).toBeInTheDocument();
  });
});

describe("AgentDispatchDialog with Prompt Estimation", () => {
  it("displays prompt token estimation inside the dispatch dialog before confirming", async () => {
    const onConfirm = vi.fn();

    render(
      <AgentDispatchDialog
        open={true}
        onOpenChange={() => {}}
        title="Dispatch Build"
        projectId="proj-1"
        agentProps={{
          value: "agent-1",
          onChange: () => {},
          dispatchRole: "build",
        }}
        promptEstimateTarget={{
          epicId: "epic-exceeded",
          dispatchType: "build",
        }}
        confirmLabel="Dispatch Agent"
        busy={false}
        onConfirm={onConfirm}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("prompt-token-estimate")).toBeInTheDocument();
    });

    // Warning is present
    expect(screen.getByTestId("prompt-budget-warning")).toBeInTheDocument();

    // Confirm button remains enabled and clickable despite the warning
    const confirmButton = screen.getByRole("button", { name: "Dispatch Agent" });
    expect(confirmButton).not.toBeDisabled();
    confirmButton.click();
    expect(onConfirm).toHaveBeenCalled();
  });
});
