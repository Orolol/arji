/**
 * AutoModeDialog + AutoModeToggle: the status load, the settings PUT body,
 * the over-budget warning, and the toolbar badge.
 *
 * The pivotal assertion is the warning: when build + review concurrency
 * exceeds the project's `agent_max_concurrent`, the dialog must SAY SO and
 * must not touch the scheduler budget (the user's decision — an unattended
 * mode never rewrites a global safety setting).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (id: string) => void;
  }) => (
    <button
      data-testid="named-agent-select"
      data-value={value ?? ""}
      onClick={() => onChange("picked-agent")}
    >
      agent
    </button>
  ),
}));

import { AutoModeDialog } from "@/components/auto-mode/AutoModeDialog";
import { AutoModeToggle } from "@/components/auto-mode/AutoModeToggle";
import type { AutoModeStatus } from "@/lib/auto-mode/status";

function statusFixture(patch: Partial<AutoModeStatus> = {}): AutoModeStatus {
  return {
    enabled: false,
    buildAgent: null,
    buildConcurrency: 2,
    reviewAgent: null,
    reviewConcurrency: 1,
    smartDispatch: false,
    effectiveSchedulerBudget: 3,
    running: false,
    lastSweepAt: null,
    inFlight: { build: 0, review: 0 },
    candidates: { build: 4, review: 2, merge: 1 },
    parked: [],
    recentDispatches: [],
    ...patch,
  };
}

interface FetchLog {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(
  initial: AutoModeStatus,
  saved?: AutoModeStatus
): FetchLog[] {
  const calls: FetchLog[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body as string) : null,
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: method === "PUT" ? (saved ?? initial) : initial }),
      } as Response;
    })
  );
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

describe("AutoModeDialog", () => {
  it("loads the current status and shows live candidate counts", async () => {
    installFetch(statusFixture());
    render(
      <AutoModeDialog projectId="p1" open onOpenChange={() => {}} />
    );

    await waitFor(() =>
      expect(screen.getByTestId("auto-mode-candidates")).toHaveTextContent(
        "4 to build · 2 to review · 1 ready to merge"
      )
    );
    expect(screen.getByTestId("auto-mode-build-concurrency")).toHaveValue(2);
    expect(screen.getByTestId("auto-mode-review-concurrency")).toHaveValue(1);
  });

  it("uses NamedAgentSelect for BOTH the build and the review agent", async () => {
    installFetch(statusFixture());
    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);
    await waitFor(() =>
      expect(screen.getAllByTestId("named-agent-select")).toHaveLength(2)
    );
  });

  it("persists the six settings through PUT and reports the new state", async () => {
    const calls = installFetch(
      statusFixture(),
      statusFixture({ enabled: true, buildConcurrency: 3 })
    );
    const onSaved = vi.fn();
    render(
      <AutoModeDialog
        projectId="p1"
        open
        onOpenChange={() => {}}
        onSaved={onSaved}
      />
    );

    await waitFor(() => screen.getByTestId("auto-mode-enabled"));
    fireEvent.click(screen.getByTestId("auto-mode-enabled"));
    fireEvent.change(screen.getByTestId("auto-mode-build-concurrency"), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByTestId("auto-mode-save"));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/projects/p1/auto-mode");
    expect(put.body).toEqual({
      enabled: true,
      buildAgent: null,
      reviewAgent: null,
      buildConcurrency: 3,
      reviewConcurrency: 1,
      smartDispatch: false,
    });
  });

  it("sends the smart-dispatch toggle, and loads it back off by default", async () => {
    const calls = installFetch(statusFixture());
    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);

    const toggle = await screen.findByTestId("auto-mode-smart-dispatch");
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("auto-mode-save"));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT")).toBe(true)
    );
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      smartDispatch: true,
    });
  });

  it("clamps an out-of-range concurrency before sending it", async () => {
    const calls = installFetch(statusFixture());
    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);

    await waitFor(() => screen.getByTestId("auto-mode-build-concurrency"));
    fireEvent.change(screen.getByTestId("auto-mode-build-concurrency"), {
      target: { value: "99" },
    });
    fireEvent.change(screen.getByTestId("auto-mode-review-concurrency"), {
      target: { value: "-5" },
    });
    fireEvent.click(screen.getByTestId("auto-mode-save"));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT")).toBe(true)
    );
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toMatchObject({
      buildConcurrency: 10,
      reviewConcurrency: 0,
    });
  });
});

describe("AutoModeDialog — scheduler budget warning", () => {
  it("stays quiet while build + review fits inside the budget", async () => {
    installFetch(
      statusFixture({
        effectiveSchedulerBudget: 3,
        buildConcurrency: 2,
        reviewConcurrency: 1,
      })
    );
    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);

    await waitFor(() => screen.getByTestId("auto-mode-build-concurrency"));
    expect(
      screen.queryByTestId("auto-mode-budget-warning")
    ).not.toBeInTheDocument();
  });

  it("warns as soon as build + review exceeds the budget", async () => {
    installFetch(
      statusFixture({
        effectiveSchedulerBudget: 3,
        buildConcurrency: 3,
        reviewConcurrency: 1,
      })
    );
    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);

    const warning = await screen.findByTestId("auto-mode-budget-warning");
    expect(warning).toHaveTextContent("3 parallel agents");
    expect(warning).toHaveTextContent("sit in the queue");
  });

  it("appears and disappears on the exact boundary as the user edits", async () => {
    installFetch(
      statusFixture({
        effectiveSchedulerBudget: 4,
        buildConcurrency: 2,
        reviewConcurrency: 1,
      })
    );
    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);

    await waitFor(() => screen.getByTestId("auto-mode-build-concurrency"));
    // 2 + 1 = 3 <= 4 → quiet.
    expect(
      screen.queryByTestId("auto-mode-budget-warning")
    ).not.toBeInTheDocument();

    // 4 + 1 = 5 > 4 → warns.
    fireEvent.change(screen.getByTestId("auto-mode-build-concurrency"), {
      target: { value: "4" },
    });
    expect(screen.getByTestId("auto-mode-budget-warning")).toBeInTheDocument();

    // 3 + 1 = 4 == 4 → exactly at budget, still quiet.
    fireEvent.change(screen.getByTestId("auto-mode-build-concurrency"), {
      target: { value: "3" },
    });
    expect(
      screen.queryByTestId("auto-mode-budget-warning")
    ).not.toBeInTheDocument();
  });

  it("never sends a scheduler-budget change of its own", async () => {
    const calls = installFetch(
      statusFixture({
        effectiveSchedulerBudget: 2,
        buildConcurrency: 5,
        reviewConcurrency: 5,
      })
    );
    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);

    await screen.findByTestId("auto-mode-budget-warning");
    fireEvent.click(screen.getByTestId("auto-mode-save"));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT")).toBe(true)
    );
    expect(
      calls.every((c) => !c.url.includes("/api/settings"))
    ).toBe(true);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).not.toHaveProperty("agent_max_concurrent");
    expect(put.body).not.toHaveProperty("effectiveSchedulerBudget");
  });

  it("reports a failed status load and refuses to save over it", async () => {
    const calls: FetchLog[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body as string) : null,
        });
        // A 404 still carries a JSON body — checking only `data` would leave
        // the dialog on its defaults and let Save overwrite the real config.
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "Project not found" }),
        } as Response;
      })
    );

    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("auto-mode-error")).toHaveTextContent(
        "Project not found"
      )
    );
    expect(screen.getByTestId("auto-mode-save")).toBeDisabled();

    fireEvent.click(screen.getByTestId("auto-mode-save"));
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("always shows the unattended-merge warning", async () => {
    installFetch(statusFixture());
    render(<AutoModeDialog projectId="p1" open onOpenChange={() => {}} />);
    const warning = await screen.findByTestId("auto-mode-warning");
    expect(warning).toHaveTextContent("merge into main");
    expect(warning).toHaveTextContent("parked");
  });
});

/* ------------------------------------------------------------------ */
/* Toolbar toggle                                                      */
/* ------------------------------------------------------------------ */

describe("AutoModeToggle", () => {
  it("shows no badge while the mode is off", async () => {
    installFetch(statusFixture({ enabled: false }));
    render(
      <AutoModeToggle projectId="p1" onOpen={() => {}} pollIntervalMs={0} />
    );

    await waitFor(() => screen.getByTestId("auto-mode-toggle"));
    expect(
      screen.queryByTestId("auto-mode-toggle-badge")
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("auto-mode-toggle")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("shows a live building/reviewing badge while the mode runs", async () => {
    installFetch(
      statusFixture({
        enabled: true,
        running: true,
        inFlight: { build: 2, review: 1 },
      })
    );
    render(
      <AutoModeToggle projectId="p1" onOpen={() => {}} pollIntervalMs={0} />
    );

    const badge = await screen.findByTestId("auto-mode-toggle-badge");
    expect(badge).toHaveTextContent("2 building · 1 reviewing");
    expect(screen.getByTestId("auto-mode-toggle")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("opens the dialog when clicked", async () => {
    installFetch(statusFixture({ enabled: true, inFlight: { build: 1, review: 0 } }));
    const onOpen = vi.fn();
    render(<AutoModeToggle projectId="p1" onOpen={onOpen} pollIntervalMs={0} />);

    // Wait for the status fetch to settle so the click is not racing a render.
    await screen.findByTestId("auto-mode-toggle-badge");
    fireEvent.click(screen.getByTestId("auto-mode-toggle"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
