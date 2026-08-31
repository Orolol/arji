/**
 * Choosing Full Auto's build and review agents from the workspace settings.
 *
 * The regression this closes: those two choices only existed in
 * `AutoModeDialog`, reachable from one toolbar on one route, so unattended
 * work fell back to the built-in default for anyone who never opened it.
 *
 * THE KEY SHAPE IS THE POINT. `/settings` writes the BARE keys, because
 * `resolveAutoModeConfig` reads `auto_mode_build_agent:<projectId>` first and
 * the bare key second. Writing a suffixed key from here would silently turn a
 * workspace default into one project's state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import SettingsPage from "@/app/settings/page";
import {
  AUTO_MODE_BUILD_AGENT_SETTING_KEY,
  AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
  autoModeBuildAgentSettingKey,
  resolveAutoModeConfig,
} from "@/lib/auto-mode/constants";

const AGENTS = [
  { id: "a1", name: "Opus Builder", provider: "claude-code" },
  { id: "a2", name: "Codex Reviewer", provider: "codex" },
];

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: AGENTS, loading: false, refresh: vi.fn() }),
}));

vi.mock("@/hooks/useDispatchReliability", () => ({
  // Real shape: the picker reads byAgentId/minSample to badge each row.
  useDispatchReliability: () => ({
    byAgentId: new Map(),
    loading: false,
    minSample: 5,
  }),
}));

function mockSettings(stored: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/settings/webhooks") {
      return { ok: true, json: async () => ({ data: { webhooks: [] } }) };
    }
    if (url === "/api/settings" && init?.method === "PATCH") {
      return { ok: true, json: async () => ({ data: { updated: true } }) };
    }
    return { ok: true, json: async () => ({ data: stored }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastPatchBody(fetchMock: ReturnType<typeof vi.fn>) {
  const calls = fetchMock.mock.calls.filter(
    (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === "PATCH",
  );
  return JSON.parse((calls[calls.length - 1][1] as { body: string }).body);
}

describe("Settings — Full Auto agents", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes a build and a review selector", async () => {
    mockSettings({});
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("full-auto-settings")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Build agent")).toBeInTheDocument();
    expect(screen.getByLabelText("Review agent")).toBeInTheDocument();
  });

  it("reads the stored values back verbatim after a reload", async () => {
    mockSettings({
      [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
      [AUTO_MODE_REVIEW_AGENT_SETTING_KEY]: "a2",
    });
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByLabelText("Build agent")).toHaveTextContent("Opus Builder"),
    );
    expect(screen.getByLabelText("Review agent")).toHaveTextContent("Codex Reviewer");
  });

  it("writes the BARE keys and never a project-suffixed one", async () => {
    const fetchMock = mockSettings({
      [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
      [AUTO_MODE_REVIEW_AGENT_SETTING_KEY]: "a2",
    });
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("save-full-auto-agents")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("save-full-auto-agents"));

    await waitFor(() => expect(lastPatchBody(fetchMock)).toBeTruthy());
    const body = lastPatchBody(fetchMock);
    expect(body).toEqual({
      [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
      [AUTO_MODE_REVIEW_AGENT_SETTING_KEY]: "a2",
    });
    // The suffixed form is a per-project override and is not this page's to write.
    for (const key of Object.keys(body)) {
      expect(key).not.toContain(":");
    }
  });

  it("stores null for 'Default' so the resolution chain takes over", async () => {
    const fetchMock = mockSettings({});
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("save-full-auto-agents")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("save-full-auto-agents"));

    await waitFor(() => expect(lastPatchBody(fetchMock)).toBeTruthy());
    expect(lastPatchBody(fetchMock)).toEqual({
      [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: null,
      [AUTO_MODE_REVIEW_AGENT_SETTING_KEY]: null,
    });
  });

  it("says that smart dispatch only covers unassigned roles", async () => {
    mockSettings({});
    render(<SettingsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("full-auto-settings")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("full-auto-settings").textContent).toMatch(
      /only applies to roles left unassigned/i,
    );
  });
});

/**
 * The engine side is unchanged; this pins the contract the settings page
 * depends on, so a future change to either is caught from both directions.
 */
describe("resolveAutoModeConfig — precedence for the bare keys", () => {
  it("uses the workspace default when the project names no agent", () => {
    const config = resolveAutoModeConfig(
      { [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1" },
      "p1",
    );
    expect(config.buildAgent).toBe("a1");
  });

  it("lets a per-project override win over the workspace default", () => {
    const config = resolveAutoModeConfig(
      {
        [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
        [autoModeBuildAgentSettingKey("p1")]: "a2",
      },
      "p1",
    );
    expect(config.buildAgent).toBe("a2");
    // …and only for that project.
    expect(resolveAutoModeConfig(
      {
        [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
        [autoModeBuildAgentSettingKey("p1")]: "a2",
      },
      "p2",
    ).buildAgent).toBe("a1");
  });

  it("falls back to no agent when the workspace default is cleared", () => {
    expect(
      resolveAutoModeConfig({ [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: null }, "p1")
        .buildAgent,
    ).toBeNull();
    expect(
      resolveAutoModeConfig({ [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "" }, "p1")
        .buildAgent,
    ).toBeNull();
  });
});
