/**
 * Settings page: the "Projects Directory" section round-trips the
 * `projects_root` override through /api/settings and shows the server-resolved
 * default as placeholder when no override is stored.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";
import { PROJECTS_ROOT_SETTING_KEY } from "@/lib/projects/workspace-constants";

const DEFAULT_ROOT = "/home/user/arij/projects";

function mockSettings(
  stored: Record<string, unknown>,
  options: { patchOk?: boolean; patchError?: string } = {}
) {
  const { patchOk = true, patchError } = options;
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
            patchOk ? { data: { updated: true } } : { error: patchError },
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: stored,
          defaults: { [PROJECTS_ROOT_SETTING_KEY]: DEFAULT_ROOT },
        }),
      };
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

async function renderSettings() {
  render(<SettingsPage />);
  await waitFor(() =>
    expect(screen.getByTestId("projects-root-settings")).toBeInTheDocument()
  );
}

describe("Settings — projects directory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the resolved default as placeholder when no override is stored", async () => {
    mockSettings({});
    await renderSettings();

    const input = screen.getByTestId("projects-root-setting");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", DEFAULT_ROOT);
  });

  it("prefills the input from the stored override", async () => {
    mockSettings({ [PROJECTS_ROOT_SETTING_KEY]: "/srv/clones" });
    await renderSettings();

    await waitFor(() =>
      expect(screen.getByTestId("projects-root-setting")).toHaveValue(
        "/srv/clones"
      )
    );
  });

  it("persists the override under projects_root and confirms", async () => {
    const fetchMock = mockSettings({});
    await renderSettings();

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "  /srv/clones  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Directory" }));

    await waitFor(() =>
      expect(screen.getByTestId("projects-root-message")).toHaveTextContent(
        "Projects directory saved."
      )
    );
    expect(lastPatchBody(fetchMock)).toEqual({
      [PROJECTS_ROOT_SETTING_KEY]: "/srv/clones",
    });
  });

  it("clears the override when saved blank", async () => {
    const fetchMock = mockSettings({
      [PROJECTS_ROOT_SETTING_KEY]: "/srv/clones",
    });
    await renderSettings();

    await waitFor(() =>
      expect(screen.getByTestId("projects-root-setting")).toHaveValue(
        "/srv/clones"
      )
    );
    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Directory" }));

    await waitFor(() =>
      expect(screen.getByTestId("projects-root-message")).toHaveTextContent(
        "Projects directory reset to the default."
      )
    );
    expect(lastPatchBody(fetchMock)).toEqual({
      [PROJECTS_ROOT_SETTING_KEY]: "",
    });
    // The default is still offered as placeholder once the override is gone.
    expect(screen.getByTestId("projects-root-setting")).toHaveAttribute(
      "placeholder",
      DEFAULT_ROOT
    );
  });

  it("surfaces the server error when the save is rejected", async () => {
    mockSettings({}, {
      patchOk: false,
      patchError: "Projects directory must be saved as a string value.",
    });
    await renderSettings();

    fireEvent.change(screen.getByTestId("projects-root-setting"), {
      target: { value: "/srv/clones" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Directory" }));

    await waitFor(() =>
      expect(screen.getByTestId("projects-root-message")).toHaveTextContent(
        "Projects directory must be saved as a string value."
      )
    );
  });
});
