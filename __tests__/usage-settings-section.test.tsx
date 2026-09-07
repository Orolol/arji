/**
 * Settings → Workspace, BUDGET band: the weekly Claude budget and the monthly
 * cap round-trip through /api/settings under their global (unsuffixed) keys.
 *
 * Both save through the tab's shared footer. The frame draws only the monthly
 * cap; the weekly budget joins it here rather than being lost.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";

/** Pinned by the contract; inlined here exactly as lib/types/usage.ts spells them. */
const BUDGET_KEY = "usage_budget_usd_7d_claude";
const MONTHLY_KEY = "usage_budget_usd_month";

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

function patchBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter((c: unknown[]) => (c[1] as RequestInit | undefined)?.method === "PATCH")
    .map((c: unknown[]) => JSON.parse((c[1] as { body: string }).body));
}

function lastPatchBody(fetchMock: ReturnType<typeof vi.fn>) {
  const bodies = patchBodies(fetchMock);
  return bodies[bodies.length - 1];
}

describe.each([
  { name: "weekly Claude budget", testId: "usage-budget-setting", key: BUDGET_KEY },
  { name: "monthly cap", testId: "monthly-cap-setting", key: MONTHLY_KEY },
])("Settings — $name", ({ testId, key }) => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prefills the input from the stored global key", async () => {
    mockSettings({ [key]: 50 });
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId(testId)).toHaveValue(50));
  });

  it("stays empty when no budget is stored", async () => {
    mockSettings({});
    render(<SettingsPage />);

    await screen.findByTestId("usage-settings");
    expect(screen.getByTestId(testId)).toHaveValue(null);
  });

  it("treats a non-positive stored value as no budget", async () => {
    mockSettings({ [key]: 0 });
    render(<SettingsPage />);

    await screen.findByTestId("usage-settings");
    expect(screen.getByTestId(testId)).toHaveValue(null);
  });

  it("saves a positive budget under the unsuffixed key", async () => {
    const fetchMock = mockSettings({});
    render(<SettingsPage />);

    await screen.findByTestId("usage-settings");
    fireEvent.change(screen.getByTestId(testId), { target: { value: "80" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(lastPatchBody(fetchMock)).toEqual({ [key]: 80 }));
    expect(await screen.findByTestId("settings-message")).toHaveTextContent("Saved");
  });

  it("clears the budget with null when the field is emptied", async () => {
    const fetchMock = mockSettings({ [key]: 50 });
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByTestId(testId)).toHaveValue(50));
    fireEvent.change(screen.getByTestId(testId), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(lastPatchBody(fetchMock)).toEqual({ [key]: null }));
  });

  it("rejects a non-positive budget without calling the API", async () => {
    const fetchMock = mockSettings({});
    render(<SettingsPage />);

    await screen.findByTestId("usage-settings");
    fireEvent.change(screen.getByTestId(testId), { target: { value: "-5" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    expect(await screen.findByTestId("settings-message")).toHaveTextContent(
      "Budget must be a positive dollar amount."
    );
    expect(patchBodies(fetchMock)).toHaveLength(0);
  });

  it("reports a failed save", async () => {
    mockSettings({}, false);
    render(<SettingsPage />);

    await screen.findByTestId("usage-settings");
    fireEvent.change(screen.getByTestId(testId), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    expect(await screen.findByTestId("settings-message")).toHaveTextContent("nope");
  });
});

describe("Settings — BUDGET band copy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not repeat the frame's false claim that the cap pauses Full Auto", async () => {
    mockSettings({});
    render(<SettingsPage />);

    const band = await screen.findByTestId("usage-settings");
    // Nothing in lib/auto-mode/* reads a spend cap; the tile that used to say
    // otherwise is documented as display-only.
    expect(band.textContent).not.toContain("pauses Full Auto and the night runs");
    expect(band).toHaveTextContent(
      "nothing pauses Full Auto or the night runs automatically"
    );
  });
});
