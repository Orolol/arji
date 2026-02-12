import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";

let mockSettings: Record<string, string> = {};
let patchCalls: Array<{ body: Record<string, string> }> = [];

beforeEach(() => {
  mockSettings = {};
  patchCalls = [];

  global.fetch = vi.fn().mockImplementation((_url: string, opts?: RequestInit) => {
    if (opts?.method === "PATCH") {
      const body = JSON.parse(opts.body as string) as Record<string, string>;
      patchCalls.push({ body });
      return Promise.resolve({
        json: () => Promise.resolve({ data: { updated: true } }),
      });
    }

    return Promise.resolve({
      json: () => Promise.resolve({ data: mockSettings }),
    });
  });
});

describe("Settings Page", () => {
  it("renders global prompt controls", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("Global Prompt")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Enter global instructions for Claude Code...")
    ).toBeInTheDocument();
  });

  it("loads existing global_prompt value", async () => {
    mockSettings = { global_prompt: "Be concise" };
    render(<SettingsPage />);

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(
        "Enter global instructions for Claude Code..."
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe("Be concise");
    });
  });

  it("saves global_prompt when Save Settings is clicked", async () => {
    render(<SettingsPage />);

    const textarea = screen.getByPlaceholderText(
      "Enter global instructions for Claude Code..."
    );
    fireEvent.change(textarea, { target: { value: "Use strict TypeScript." } });

    fireEvent.click(screen.getByText("Save Settings"));

    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0].body).toEqual({ global_prompt: "Use strict TypeScript." });
    });
  });
});
