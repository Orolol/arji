/**
 * Settings → Workspace: the two night-run defaults (circuit breaker, cost cap)
 * round-trip through /api/settings.
 *
 * They now save through the tab's shared Discard / Save footer instead of a
 * per-card button, so only the keys the user actually edited travel.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";
import {
  NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
  NIGHT_COST_CAP_SETTING_KEY,
} from "@/lib/night/constants";

function mockSettings(stored: Record<string, unknown>, patchOk = true) {
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings/webhooks") {
        return { ok: true, json: async () => ({ data: { webhooks: [] } }) };
      }
      if (url === "/api/settings" && init?.method === "PATCH") {
        return {
          ok: patchOk,
          json: async () =>
            patchOk ? { data: { updated: true } } : { error: "nope" },
        };
      }
      if (url === "/api/projects") {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url === "/api/usage") {
        return { ok: true, json: async () => ({ data: {} }) };
      }
      return { ok: true, json: async () => ({ data: stored }) };
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Body of the last PATCH /api/settings call. */
function lastPatchBody(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls.filter(
    (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === "PATCH"
  );
  return JSON.parse((calls[calls.length - 1][1] as { body: string }).body);
}

describe("Settings — night run defaults", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prefills both inputs from the stored settings", async () => {
    mockSettings({
      [NIGHT_CIRCUIT_BREAKER_SETTING_KEY]: 5,
      [NIGHT_COST_CAP_SETTING_KEY]: 25,
    });
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-circuit-breaker-setting")).toHaveValue(5)
    );
    expect(screen.getByTestId("night-cost-cap-setting")).toHaveValue(25);
  });

  it("leaves the inputs empty when nothing is stored (engine default / unlimited)", async () => {
    mockSettings({});
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-settings")).toBeInTheDocument()
    );
    expect(screen.getByTestId("night-circuit-breaker-setting")).toHaveValue(null);
    expect(screen.getByTestId("night-cost-cap-setting")).toHaveValue(null);
    expect(screen.getByTestId("night-cost-cap-setting")).toHaveAttribute(
      "placeholder",
      "Unlimited"
    );
  });

  it("saves edited values as numbers", async () => {
    const fetchMock = mockSettings({});
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-settings")).toBeInTheDocument()
    );

    fireEvent.change(screen.getByTestId("night-circuit-breaker-setting"), {
      target: { value: "2" },
    });
    fireEvent.change(screen.getByTestId("night-cost-cap-setting"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-message")).toHaveTextContent("Saved")
    );
    expect(lastPatchBody(fetchMock)).toEqual({
      [NIGHT_CIRCUIT_BREAKER_SETTING_KEY]: 2,
      [NIGHT_COST_CAP_SETTING_KEY]: 15,
    });
  });

  it("stores an empty cost cap as null (unlimited)", async () => {
    const fetchMock = mockSettings({
      [NIGHT_CIRCUIT_BREAKER_SETTING_KEY]: 4,
      [NIGHT_COST_CAP_SETTING_KEY]: 25,
    });
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-cost-cap-setting")).toHaveValue(25)
    );

    fireEvent.change(screen.getByTestId("night-cost-cap-setting"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(lastPatchBody(fetchMock)).toBeTruthy());
    // Empty CLEARS the cap — it is written as null, never omitted, and the
    // untouched breaker does not ride along.
    expect(lastPatchBody(fetchMock)).toEqual({
      [NIGHT_COST_CAP_SETTING_KEY]: null,
    });
  });

  it("refuses an unparseable circuit breaker without calling the API", async () => {
    const fetchMock = mockSettings({});
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-settings")).toBeInTheDocument()
    );
    fireEvent.change(screen.getByTestId("night-circuit-breaker-setting"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-message")).toHaveTextContent(
        "Circuit breaker must be a whole number between 0 and 10."
      )
    );
    const patches = fetchMock.mock.calls.filter(
      (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patches).toHaveLength(0);
  });

  it("writes back the clamped breaker after a successful save", async () => {
    const fetchMock = mockSettings({});
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-settings")).toBeInTheDocument()
    );
    fireEvent.change(screen.getByTestId("night-circuit-breaker-setting"), {
      target: { value: "99" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() =>
      expect(lastPatchBody(fetchMock)).toEqual({
        [NIGHT_CIRCUIT_BREAKER_SETTING_KEY]: 10,
      })
    );
    // What is stored is what is shown: the field snaps to the clamped value.
    await waitFor(() =>
      expect(screen.getByTestId("night-circuit-breaker-setting")).toHaveValue(10)
    );
  });

  it("reports a failed save without pretending it worked", async () => {
    mockSettings({}, false);
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("night-settings")).toBeInTheDocument()
    );
    fireEvent.change(screen.getByTestId("night-cost-cap-setting"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-message")).toHaveTextContent("nope")
    );
    // The edit stays on screen: nothing was persisted.
    expect(screen.getByTestId("night-cost-cap-setting")).toHaveValue(12);
  });
});
