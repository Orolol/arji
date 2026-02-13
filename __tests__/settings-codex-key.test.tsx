import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/settings/page";

let mockSettings: Record<string, unknown> = {};
let patchCalls: Array<{ body: Record<string, unknown> }> = [];
let validateShouldFail = false;
let patchShouldFail = false;

beforeEach(() => {
  mockSettings = {};
  patchCalls = [];
  validateShouldFail = false;
  patchShouldFail = false;

  global.fetch = vi
    .fn()
    .mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === "PATCH") {
        const body = JSON.parse(opts.body as string) as Record<string, unknown>;
        patchCalls.push({ body });
        return Promise.resolve({
          ok: !patchShouldFail,
          json: () =>
            Promise.resolve(
              patchShouldFail
                ? { error: "Save failed: permission denied" }
                : { data: { updated: true } }
            ),
        });
      }

      if (url.endsWith("/api/settings/github/validate")) {
        return Promise.resolve({
          ok: !validateShouldFail,
          json: () =>
            Promise.resolve(
              validateShouldFail
                ? { data: { valid: false }, error: "Token missing repo scope" }
                : { data: { valid: true, login: "octocat" } }
            ),
        });
      }

      return Promise.resolve({
        ok: true,
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

  it("renders GitHub PAT input with validate and save actions", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub PAT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate Token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Token" })).toBeInTheDocument();
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

  it("shows saved token indicator when github_pat exists", async () => {
    mockSettings = { github_pat: { hasToken: true } };
    render(<SettingsPage />);

    expect(
      await screen.findByText("A GitHub token is already saved for this workspace.")
    ).toBeInTheDocument();
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
    }
    );
  });

  it("validates and saves GitHub token", async () => {
    render(<SettingsPage />);
    const tokenInput = screen.getByLabelText("GitHub PAT");

    fireEvent.change(tokenInput, { target: { value: "ghp_123" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate Token" }));

    expect(
      await screen.findByText("Token is valid for GitHub account: octocat.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Token" }));

    await waitFor(() => {
      expect(patchCalls).toContainEqual({ body: { github_pat: "ghp_123" } });
    });
  });

  it("shows actionable validation failure message", async () => {
    validateShouldFail = true;
    render(<SettingsPage />);
    const tokenInput = screen.getByLabelText("GitHub PAT");

    fireEvent.change(tokenInput, { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate Token" }));

    expect(await screen.findByText("Token missing repo scope")).toBeInTheDocument();
  });

  it("shows actionable save failure message", async () => {
    patchShouldFail = true;
    render(<SettingsPage />);
    const tokenInput = screen.getByLabelText("GitHub PAT");

    fireEvent.change(tokenInput, { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Token" }));

    expect(
      await screen.findByText("Save failed: permission denied")
    ).toBeInTheDocument();
  });
});
