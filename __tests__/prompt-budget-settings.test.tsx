import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import SettingsPage from "@/app/settings/page";
import ProjectSettingsPage from "@/app/projects/[projectId]/settings/page";
import {
  PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
  promptTokenBudgetSettingKey,
} from "@/lib/tokens";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: () => ({
    projectId: "proj-123",
  }),
}));

beforeEach(() => {
  global.fetch = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
    if (url === "/api/settings" && opts?.method === "PATCH") {
      const body = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: body }),
      });
    }
    if (url === "/api/settings/webhooks") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: { webhooks: [] } }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            [PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY]: 50000,
          },
          defaults: {},
        }),
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The global half lives in the BUDGET band of Settings -> Workspace and
// saves through that tab's shared footer. The project half below still
// targets app/projects/[projectId]/settings/page.tsx and is untouched.
describe("Prompt Token Budget in SettingsPage", () => {
  it("renders the prompt token budget input with loaded setting", async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("prompt-budget-settings")).toBeInTheDocument();
    });

    await waitFor(() => {
      const input = screen.getByTestId(
        "prompt-token-budget-setting"
      ) as HTMLInputElement;
      expect(input.value).toBe("50000");
    });
  });

  it("updates and saves the prompt token budget", async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("prompt-budget-settings")).toBeInTheDocument();
    });

    const input = screen.getByTestId("prompt-token-budget-setting");
    fireEvent.change(input, { target: { value: "75k" } });

    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-message")).toHaveTextContent("Saved");
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          [PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY]: 75000,
        }),
      })
    );
  });

  it("refuses a non-numeric threshold without PATCHing", async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("prompt-budget-settings")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("prompt-token-budget-setting"), {
      target: { value: "lots" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("settings-message")).toHaveTextContent(
        "Budget must be a positive integer token count (e.g. 50000 or 50k)."
      );
    });
    const patches = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(patches).toHaveLength(0);
  });
});

describe("Project Token Budget in ProjectSettingsPage", () => {
  it("renders and saves project-level prompt token budget override", async () => {
    render(<ProjectSettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("project-prompt-budget-settings")).toBeInTheDocument();
    });

    const input = screen.getByTestId("project-prompt-token-budget-setting");
    fireEvent.change(input, { target: { value: "30k" } });

    const saveButton = screen.getByTestId("project-prompt-token-budget-save");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByTestId("project-prompt-token-budget-message")).toHaveTextContent("Project budget saved.");
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          [promptTokenBudgetSettingKey("proj-123")]: 30000,
        }),
      })
    );
  });
});
