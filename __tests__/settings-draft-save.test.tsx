/**
 * The draft-and-commit contract shared by the Workspace and Pipeline tabs.
 *
 * One PATCH per Save, carrying ONLY the keys that changed; a there-and-back
 * edit un-dirties; a refused pre-parse issues no request at all; and a failed
 * PATCH keeps the user's values on screen with the server's own words.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import SettingsPage from "@/app/settings/page";
import PipelineSettingsPage from "@/app/settings/pipeline/page";
import { PROJECTS_ROOT_SETTING_KEY } from "@/lib/projects/workspace-constants";
import { NIGHT_COST_CAP_SETTING_KEY } from "@/lib/night/constants";

let stored: Record<string, unknown> = {};
let patchBodies: Array<Record<string, unknown>> = [];
let patchOk = true;
let patchError: string | undefined;

function mockFetch() {
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings" && init?.method === "PATCH") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        patchBodies.push(body);
        if (patchOk) Object.assign(stored, body);
        return {
          ok: patchOk,
          json: async () =>
            patchOk ? { data: { updated: true } } : { error: patchError },
        };
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
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
  stored = {};
  patchBodies = [];
  patchOk = true;
  patchError = undefined;
  mockFetch();
});

async function renderWorkspace() {
  render(<SettingsPage />);
  await waitFor(() =>
    expect(screen.getByTestId("projects-root-setting")).toBeInTheDocument()
  );
}

describe("Settings — draft and commit", () => {
  it("disables Save and Discard until something is dirty", async () => {
    await renderWorkspace();

    expect(screen.getByTestId("settings-save")).toBeDisabled();
    expect(screen.getByTestId("settings-discard")).toBeDisabled();

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/clones" },
    });

    expect(screen.getByTestId("settings-save")).not.toBeDisabled();
    expect(screen.getByTestId("settings-discard")).not.toBeDisabled();
  });

  it("PATCHes only the key that changed", async () => {
    await renderWorkspace();

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/clones" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ [PROJECTS_ROOT_SETTING_KEY]: "/srv/clones" });
  });

  it("PATCHes two edited fields in ONE request", async () => {
    await renderWorkspace();

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/clones" },
    });
    fireEvent.change(screen.getByTestId("night-cost-cap-setting"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({
      [PROJECTS_ROOT_SETTING_KEY]: "/srv/clones",
      [NIGHT_COST_CAP_SETTING_KEY]: 12,
    });
  });

  it("un-dirties a there-and-back edit without any request", async () => {
    stored = { [PROJECTS_ROOT_SETTING_KEY]: "/srv/clones" };
    await renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("projects-root-setting")).toHaveValue("/srv/clones")
    );

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/other" },
    });
    expect(screen.getByTestId("settings-save")).not.toBeDisabled();

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/clones" },
    });
    expect(screen.getByTestId("settings-save")).toBeDisabled();
    expect(patchBodies).toHaveLength(0);
  });

  it("restores the loaded values on Discard", async () => {
    stored = { [PROJECTS_ROOT_SETTING_KEY]: "/srv/clones" };
    await renderWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("projects-root-setting")).toHaveValue("/srv/clones")
    );

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/tmp/nope" },
    });
    fireEvent.click(screen.getByTestId("settings-discard"));

    expect(screen.getByTestId("projects-root-setting")).toHaveValue("/srv/clones");
    expect(screen.getByTestId("settings-save")).toBeDisabled();
    expect(screen.getByTestId("settings-discard")).toBeDisabled();
    expect(patchBodies).toHaveLength(0);
  });

  it("keeps the edited values and the server's words when the PATCH fails", async () => {
    patchOk = false;
    patchError = "Projects directory must be saved as a string value.";
    await renderWorkspace();

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/clones" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-message")).toHaveTextContent(
        "Projects directory must be saved as a string value."
      )
    );
    expect(screen.getByTestId("projects-root-setting")).toHaveValue("/srv/clones");
    expect(screen.getByTestId("settings-save")).not.toBeDisabled();
  });

  it("issues ZERO requests when a pre-parse refuses the batch", async () => {
    render(<PipelineSettingsPage />);
    const commands = await waitFor(() => screen.getByTestId("verify-commands"));

    // One good key and one bad one: the route validates all before writing
    // any, and so does the screen.
    fireEvent.change(screen.getByTestId("verify-timeout-ms"), {
      target: { value: "45000" },
    });
    fireEvent.change(commands, { target: { value: "not json at all" } });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-message")).toHaveTextContent(
        "Verification commands must be a JSON array of objects"
      )
    );
    expect(patchBodies).toHaveLength(0);
    // Save stays available: the user can fix the value and try again.
    expect(screen.getByTestId("settings-save")).not.toBeDisabled();
  });

  it("clears the draft and re-disables the footer after a successful save", async () => {
    await renderWorkspace();

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/clones" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-save")).toBeDisabled()
    );
    expect(screen.getByTestId("settings-discard")).toBeDisabled();
    expect(screen.getByTestId("projects-root-setting")).toHaveValue("/srv/clones");
  });

  it("announces the failure as an alert and the confirmation as a status", async () => {
    await renderWorkspace();
    const region = screen.getByTestId("settings-message");
    expect(region).toHaveAttribute("role", "status");

    patchOk = false;
    patchError = "nope";
    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/clones" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-message")).toHaveAttribute("role", "alert")
    );
  });
});
