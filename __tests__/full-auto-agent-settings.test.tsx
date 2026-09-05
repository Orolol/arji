/**
 * Choosing Full Auto's build and review agents from the workspace settings.
 *
 * The regression this closes: those two choices only existed in
 * `AutoModeDialog`, reachable from one toolbar on one route, so unattended
 * work fell back to the built-in default for anyone who never opened it.
 *
 * THE KEY SHAPE IS THE POINT. The band writes the BARE keys, because
 * `resolveAutoModeConfig` reads `auto_mode_build_agent:<projectId>` first and
 * the bare key second. Writing a suffixed key from here would silently turn a
 * workspace default into one project's state.
 *
 * The controls are batched into the tab's one draft, so a change leaves in the
 * single `PATCH /api/settings` the Save footer sends — there is no per-card
 * save button on this screen any more.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import SettingsPage from "@/app/settings/page";
import {
  AUTO_MODE_BUILD_AGENT_SETTING_KEY,
  AUTO_MODE_ENABLED_SETTING_KEY,
  AUTO_MODE_REVIEW_AGENT_SETTING_KEY,
  autoModeBuildAgentSettingKey,
  autoModeEnabledSettingKey,
  resolveAutoModeConfig,
} from "@/lib/auto-mode/constants";

const AGENTS = [
  { id: "a1", name: "Opus Builder", provider: "claude-code" },
  { id: "a2", name: "Codex Reviewer", provider: "codex" },
];

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: AGENTS, loading: false, refresh: vi.fn() }),
}));

let patchBodies: Array<Record<string, unknown>> = [];

function mockSettings(stored: Record<string, unknown>) {
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings" && init?.method === "PATCH") {
        patchBodies.push(JSON.parse(init.body as string));
        return { ok: true, json: async () => ({ data: { updated: true } }) };
      }
      if (url === "/api/settings/webhooks") {
        return { ok: true, json: async () => ({ data: { webhooks: [] } }) };
      }
      if (url === "/api/projects") {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url === "/api/usage") {
        return { ok: true, json: async () => ({ data: {} }) };
      }
      return { ok: true, json: async () => ({ data: stored, defaults: {} }) };
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The band's body is dimmed while the master switch is off, and every control
 * in it but the two role pills is disabled with it. These cases arm the bare
 * key so they read the ordinary armed workspace; the bare-off case is its own
 * describe block at the bottom of the file.
 */
const ARMED = { [AUTO_MODE_ENABLED_SETTING_KEY]: true };

async function renderArmed(stored: Record<string, unknown>) {
  mockSettings({ ...ARMED, ...stored });
  render(<SettingsPage />);
  await waitFor(() =>
    expect(screen.getByTestId("full-auto-settings")).toBeInTheDocument(),
  );
}

/** Open a role pill's menu and pick an entry by its visible name. */
async function choose(testId: string, option: string) {
  // Radix opens its menu on pointerdown, which fireEvent.click does not send.
  const user = userEvent.setup();
  await user.click(within(screen.getByTestId(testId)).getByRole("button"));
  await user.click(await screen.findByRole("menuitem", { name: option }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  patchBodies = [];
});

describe("Settings — Full Auto agents", () => {
  it("exposes a build and a review selector", async () => {
    await renderArmed({});

    expect(screen.getByTestId("auto-build-agent")).toBeInTheDocument();
    expect(screen.getByTestId("auto-review-agent")).toBeInTheDocument();
  });

  it("reads the stored values back verbatim after a reload", async () => {
    await renderArmed({
      [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
      [AUTO_MODE_REVIEW_AGENT_SETTING_KEY]: "a2",
    });

    // The NAME, never the id — an id on screen is unreadable.
    expect(screen.getByTestId("auto-build-agent")).toHaveTextContent("Opus Builder");
    expect(screen.getByTestId("auto-review-agent")).toHaveTextContent("Codex Reviewer");
  });

  it("shows Default, not a blank pill, when nothing is stored", async () => {
    await renderArmed({});

    expect(screen.getByTestId("auto-build-agent")).toHaveTextContent("Default");
    expect(screen.getByTestId("auto-review-agent")).toHaveTextContent("Default");
  });

  it("falls back to Default when the stored agent no longer exists", async () => {
    await renderArmed({ [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "deleted-agent" });

    // Not the raw id: the resolution chain will fall through, and the pill
    // must say what will actually happen.
    expect(screen.getByTestId("auto-build-agent")).toHaveTextContent("Default");
    expect(screen.getByTestId("auto-build-agent")).not.toHaveTextContent("deleted-agent");
  });

  it("writes the BARE keys and never a project-suffixed one", async () => {
    await renderArmed({});

    await choose("auto-build-agent", "Opus Builder");
    await choose("auto-review-agent", "Codex Reviewer");
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({
      [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
      [AUTO_MODE_REVIEW_AGENT_SETTING_KEY]: "a2",
    });
    // The suffixed form is a per-project override and is not this screen's to write.
    for (const key of Object.keys(patchBodies[0])) {
      expect(key).not.toContain(":");
    }
  });

  it("stores null for 'Default' so the resolution chain takes over", async () => {
    await renderArmed({
      [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
      [AUTO_MODE_REVIEW_AGENT_SETTING_KEY]: "a2",
    });

    await choose("auto-build-agent", "Default");
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // null, and WRITTEN: omitting the key would leave "a1" in the database
    // while the pill showed Default. The untouched review role stays out.
    expect(patchBodies[0]).toEqual({ [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: null });
  });

  it("sends nothing for a there-and-back choice", async () => {
    await renderArmed({ [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1" });

    await choose("auto-build-agent", "Codex Reviewer");
    await choose("auto-build-agent", "Opus Builder");

    expect(screen.getByTestId("settings-save")).toBeDisabled();
  });

  it("says that smart dispatch only covers unassigned roles", async () => {
    await renderArmed({});

    expect(screen.getByTestId("full-auto-settings").textContent).toMatch(
      /rôles non assignés/i,
    );
  });
});

/**
 * The engine side is unchanged; this pins the contract the settings band
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

/**
 * THE MASTER SWITCH ON THIS BAND IS NOT THE ONE THE SUPERVISOR READS.
 *
 * The band's toggle writes the BARE `auto_mode_enabled`; the desk popover
 * arms one project through `auto_mode_enabled:<projectId>`, and
 * `resolveAutoModeConfigForProject` reads the suffixed key FIRST. So a
 * workspace whose bare key is absent can be armed and dispatching — observed
 * live: build + review sessions created, worktree, CLI spawned — while this
 * band believes Full Auto is off.
 *
 * Dimming the band under a bare-off master is the frame's pattern and stays.
 * DISABLING the two role pills does not: they are the workspace default rung
 * of the project → global → built-in chain, so their value is what decides
 * which agent runs that armed project's unattended work. A user who arms
 * projects one at a time — the flow the desk popover encourages — could not
 * reach the setting at all.
 */
describe("Settings — Full Auto agents while the bare master is off", () => {
  /** Armed the way the desk popover arms it: the suffixed key only. */
  const ARMED_FROM_THE_DESK = {
    [autoModeEnabledSettingKey("p1")]: true,
  };

  async function renderStored(stored: Record<string, unknown>) {
    mockSettings(stored);
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("full-auto-settings")).toBeInTheDocument(),
    );
  }

  it("leaves both role pills enabled", async () => {
    await renderStored(ARMED_FROM_THE_DESK);

    // The reported symptom, verbatim: `element is not enabled`, click never lands.
    expect(
      within(screen.getByTestId("auto-build-agent")).getByRole("button"),
    ).toBeEnabled();
    expect(
      within(screen.getByTestId("auto-review-agent")).getByRole("button"),
    ).toBeEnabled();
  });

  it("still writes the workspace default a bare-off master keeps in force", async () => {
    await renderStored(ARMED_FROM_THE_DESK);

    await choose("auto-build-agent", "Opus Builder");
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({
      [AUTO_MODE_BUILD_AGENT_SETTING_KEY]: "a1",
    });
  });

  /**
   * The dimmed body disables its contents twice over — `pointer-events-none`
   * and `aria-disabled="true"` — and jsdom reports neither as a click that
   * fails: it loads no stylesheet, and it does not propagate `aria-disabled`
   * to descendants the way assistive tech and Playwright's actionability
   * check do. Both opt-outs are asserted here as attributes because that is
   * the only observable this layer has; the browser-level proof that the
   * click lands is `e2e/full-auto-agents.spec.ts`.
   */
  it("opts the pills out of both halves of the dimmed body", async () => {
    await renderStored(ARMED_FROM_THE_DESK);

    expect(screen.getByTestId("full-auto-body")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const live = screen.getByTestId("full-auto-agents-live");
    expect(live.className).toContain("pointer-events-auto");
    expect(live).toHaveAttribute("aria-disabled", "false");
    // …and they really are inside it, not beside it.
    expect(live).toContainElement(screen.getByTestId("auto-build-agent"));
    expect(live).toContainElement(screen.getByTestId("auto-review-agent"));
  });

  /**
   * The scope line: the pills are the ONE control here whose value keeps
   * having an effect while the master is off. Everything else in the band
   * still dims and disables together.
   */
  it("keeps the rest of the band disabled", async () => {
    await renderStored(ARMED_FROM_THE_DESK);

    expect(screen.getByTestId("auto-smart-dispatch")).toBeDisabled();
    expect(screen.getByTestId("auto-second-opinion")).toBeDisabled();
    expect(
      within(screen.getByTestId("agent-max-concurrent")).getAllByRole("button")[0],
    ).toBeDisabled();
  });

  it("still disables nothing extra once the bare master is armed", async () => {
    await renderStored({ [AUTO_MODE_ENABLED_SETTING_KEY]: true });

    expect(screen.getByTestId("full-auto-body")).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByTestId("auto-smart-dispatch")).toBeEnabled();
    expect(
      within(screen.getByTestId("auto-build-agent")).getByRole("button"),
    ).toBeEnabled();
  });
});
