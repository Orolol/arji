/**
 * The reliability badge inside the agent picker
 * (components/shared/NamedAgentSelect.tsx).
 *
 * The assertions that matter: the badge is scoped to the picker's own task
 * type, it collapses to an em-dash under the sample threshold, and however
 * many pickers a page mounts they share ONE request — a badge that queried
 * per agent would be the N+1 the endpoint exists to prevent.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// Stand-in for the shadcn Select (Radix popper is not drivable from jsdom).
// Divs rather than the native <select> the sibling clear-row test uses:
// SelectItem now renders rich content (name + badge), which a real <option>
// may not contain.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => (
    <div data-testid="agent-select-native">{children}</div>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <div role="option" aria-selected={false} data-value={value}>
      {children}
    </div>
  ),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: [
      { id: "agent-a", name: "Alpha", provider: "claude-code", model: "opus" },
      { id: "agent-b", name: "Beta", provider: "codex", model: "gpt" },
    ],
    loading: false,
    refresh: vi.fn(),
  }),
}));

const { NamedAgentSelect } = await import(
  "@/components/shared/NamedAgentSelect"
);
const { resetDispatchReliabilityCache } = await import(
  "@/hooks/useDispatchReliability"
);

const ROWS = [
  {
    namedAgentId: "agent-a",
    agentName: "Alpha",
    role: "build",
    sampleSize: 8,
    completedCount: 7,
    failedCount: 1,
    successRate: 7 / 8,
    medianDurationMs: 252_000,
  },
  {
    // Same agent, different role — must not colour the build badge.
    namedAgentId: "agent-a",
    agentName: "Alpha",
    role: "review",
    sampleSize: 10,
    completedCount: 3,
    failedCount: 7,
    successRate: 0.3,
    medianDurationMs: 60_000,
  },
  {
    // Under the threshold: an em-dash, never "100%".
    namedAgentId: "agent-b",
    agentName: "Beta",
    role: "build",
    sampleSize: 3,
    completedCount: 3,
    failedCount: 0,
    successRate: 1,
    medianDurationMs: 30_000,
  },
];

function installFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: { windowDays: 30, minSample: 5, rows: ROWS },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetDispatchReliabilityCache();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterEach(() => {
  resetDispatchReliabilityCache();
});

describe("NamedAgentSelect reliability badge", () => {
  it("shows the 30-day rate and median for the picker's own task type", async () => {
    installFetch();
    render(
      <NamedAgentSelect value={null} onChange={vi.fn()} dispatchRole="build" />
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-reliability-agent-a")).toHaveTextContent(
        "88% · 4m 12s"
      )
    );
    expect(screen.getByTestId("agent-reliability-agent-a")).toHaveAttribute(
      "title",
      expect.stringContaining("7/8 build runs succeeded")
    );
  });

  it("scores the same agent differently for a different task type", async () => {
    installFetch();
    render(
      <NamedAgentSelect value={null} onChange={vi.fn()} dispatchRole="review" />
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-reliability-agent-a")).toHaveTextContent(
        "30% · 1m 0s"
      )
    );
  });

  it("renders an em-dash under 5 sessions instead of a misleading percentage", async () => {
    installFetch();
    render(
      <NamedAgentSelect value={null} onChange={vi.fn()} dispatchRole="build" />
    );

    const badge = await screen.findByTestId("agent-reliability-agent-b");
    expect(badge).toHaveTextContent("—");
    expect(badge).not.toHaveTextContent("100%");
  });

  it("shows an em-dash for an agent with no history at all", async () => {
    installFetch();
    // 'merge' has no rows in the payload.
    render(
      <NamedAgentSelect value={null} onChange={vi.fn()} dispatchRole="merge" />
    );

    await waitFor(() =>
      expect(screen.getByTestId("agent-reliability-agent-a")).toHaveTextContent(
        "—"
      )
    );
    expect(screen.getByTestId("agent-reliability-agent-b")).toHaveTextContent(
      "—"
    );
  });

  it("fetches once for several pickers on the page — no request per agent", async () => {
    const fetchMock = installFetch();
    render(
      <>
        <NamedAgentSelect value={null} onChange={vi.fn()} dispatchRole="build" />
        <NamedAgentSelect
          value={null}
          onChange={vi.fn()}
          dispatchRole="review"
        />
        <NamedAgentSelect value={null} onChange={vi.fn()} dispatchRole="build" />
      </>
    );

    await waitFor(() =>
      expect(
        screen.getAllByTestId("agent-reliability-agent-a").length
      ).toBeGreaterThan(0)
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/agent-config/dispatch-stats");
  });

  it("does not fetch at all when the picker declares no task type", async () => {
    const fetchMock = installFetch();
    render(<NamedAgentSelect value={null} onChange={vi.fn()} />);

    expect(screen.queryByTestId("agent-reliability-agent-a")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
