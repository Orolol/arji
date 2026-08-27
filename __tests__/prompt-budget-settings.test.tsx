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

describe("Prompt Token Budget in SettingsPage", () => {
  it("renders the prompt token budget input with loaded setting", async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("prompt-budget-settings")).toBeInTheDocument();
    });

    const input = screen.getByTestId("prompt-token-budget-setting") as HTMLInputElement;
    expect(input.value).toBe("50000");
  });

  it("updates and saves the prompt token budget", async () => {
    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("prompt-budget-settings")).toBeInTheDocument();
    });

    const input = screen.getByTestId("prompt-token-budget-setting");
    fireEvent.change(input, { target: { value: "75k" } });

    const saveButton = screen.getByTestId("prompt-token-budget-save");
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(screen.getByTestId("prompt-token-budget-message")).toHaveTextContent("Saved");
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
