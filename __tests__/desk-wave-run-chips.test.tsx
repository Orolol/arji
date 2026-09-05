/**
 * Wave and night-run state in WORKING's header.
 *
 * Replaces `agent-monitor-wave-indicator` and `night-run-monitor-chip`: the
 * chips and the run-level stop control moved out of the pre-redesign
 * AgentMonitor bar and into the desk's turquoise stratum, unchanged in
 * behaviour. The registry read is the same endpoint.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WaveRunChips } from "@/components/desk/WaveRunChips";
import { NIGHT_RUN_ID_PREFIX } from "@/lib/night/constants";

function mockWaves(batchId: string, currentWave = 2, totalWaves = 4) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: [{ batchId, currentWave, totalWaves }] }),
  });
}

describe("WaveRunChips", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows 'Wave 2/4' while a DAG batch is running", async () => {
    mockWaves("batch-1");
    render(<WaveRunChips projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("desk-wave-batch-1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("desk-wave-batch-1").textContent).toContain("Wave 2/4");
    expect(global.fetch).toHaveBeenCalledWith("/api/projects/proj-1/build/waves");
  });

  it("renders wave 1 while the first wave is still dispatching (currentWave 0)", async () => {
    mockWaves("batch-2", 0, 3);
    render(<WaveRunChips projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("desk-wave-batch-2").textContent).toContain("Wave 1/3"),
    );
  });

  it("shows nothing when no DAG batch is active", async () => {
    global.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ data: [] }) });
    render(<WaveRunChips projectId="proj-1" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Wave/)).not.toBeInTheDocument();
  });

  it("survives a failing waves endpoint", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    render(<WaveRunChips projectId="proj-1" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/Wave/)).not.toBeInTheDocument();
  });

  it("never polls without a project — '/' has no single registry to read", () => {
    global.fetch = vi.fn();
    const { container } = render(<WaveRunChips />);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it("labels a night run's waves as 'Night wave'", async () => {
    const batchId = `${NIGHT_RUN_ID_PREFIX}abc123`;
    mockWaves(batchId);
    render(<WaveRunChips projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByTestId(`desk-wave-${batchId}`)).toBeInTheDocument(),
    );
    const chip = screen.getByTestId(`desk-wave-${batchId}`);
    expect(chip.textContent).toContain("Night wave 2/4");
    expect(chip).toHaveAttribute("data-night", "true");
  });

  it("leaves a plain DAG batch without a run-level stop control", async () => {
    mockWaves("batch-9");
    render(<WaveRunChips projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("desk-wave-batch-9")).toBeInTheDocument(),
    );
    const chip = screen.getByTestId("desk-wave-batch-9");
    expect(chip.textContent).toContain("Wave 2/4");
    expect(chip.textContent).not.toContain("Night");
    expect(chip).not.toHaveAttribute("data-night");
    expect(screen.queryByTestId("desk-night-stop")).not.toBeInTheDocument();
  });

  it("stops the night run and latches the button", async () => {
    const batchId = `${NIGHT_RUN_ID_PREFIX}stopme`;
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        calls.push({ url, method: init?.method });
        return {
          ok: true,
          status: 200,
          json: async () =>
            init?.method === "POST"
              ? { data: { stopping: true } }
              : { data: [{ batchId, currentWave: 1, totalWaves: 3 }] },
        };
      }),
    );

    render(<WaveRunChips projectId="proj-1" />);

    const stop = await screen.findByTestId("desk-night-stop");
    expect(stop).toHaveTextContent("Stop night run");
    await userEvent.click(stop);

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.method === "POST" &&
            call.url === `/api/projects/proj-1/build/night-runs/${batchId}/stop`,
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId("desk-night-stop")).toHaveTextContent("Stopping…"),
    );
    expect(screen.getByTestId("desk-night-stop")).toBeDisabled();
  });
});

/**
 * The stop control has to be reachable in ONE action, which means it must not
 * depend on WORKING having a session in flight.
 *
 * The chips briefly took an `active` prop wired to
 * `working.length > 0 || queued.length > 0`. That matched AgentMonitor's old
 * mount condition, so it was parity — but it hid "Stop night run" between two
 * epics of a run and right after a failure, which is when a user most wants it.
 */
describe("WaveRunChips polling is not gated on live work", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps 'Stop night run' on screen while no session is running or queued", async () => {
    // The registry still holds the run; WORKING is momentarily empty.
    mockWaves(`${NIGHT_RUN_ID_PREFIX}run-9`);
    render(<WaveRunChips projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("desk-night-stop")).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith("/api/projects/proj-1/build/waves");
  });

  it("still polls the registry when the desk has nothing live to show", async () => {
    // An empty registry answer is the idle case: the component must keep
    // asking, because the run can reappear on the very next tick.
    global.fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ data: [] }) });
    render(<WaveRunChips projectId="proj-1" />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith("/api/projects/proj-1/build/waves");
  });
});
