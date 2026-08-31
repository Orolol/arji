/**
 * The GitHub PAT card (Settings → Intégrations) and the global prompt
 * (Settings → Pipeline).
 *
 * They used to share one 1862-line page; they now live on the two tabs whose
 * save model each of them needs. The PAT is a masked secret with its own
 * buttons — batching it would offer to save an always-empty field. The global
 * prompt is an ordinary batched key and rides the tab footer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import IntegrationsSettingsPage from "@/app/settings/integrations/page";
import PipelineSettingsPage from "@/app/settings/pipeline/page";

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

      if (url === "/api/settings/webhooks") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { webhooks: [] } }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: mockSettings }),
      });
    });
});

describe("Settings → Intégrations — GitHub", () => {
  it("renders GitHub PAT input with validate and save actions", () => {
    render(<IntegrationsSettingsPage />);
    expect(screen.getByRole("heading", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByLabelText("GitHub PAT")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Validate Token" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Token" })).toBeInTheDocument();
  });

  it("shows saved token indicator when github_pat exists", async () => {
    mockSettings = { github_pat: { hasToken: true } };
    render(<IntegrationsSettingsPage />);

    expect(
      await screen.findByText("A GitHub token is already saved for this workspace.")
    ).toBeInTheDocument();
  });

  it("validates and saves GitHub token", async () => {
    render(<IntegrationsSettingsPage />);
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
    // The masked secret never round-trips: the field empties on success.
    expect(screen.getByLabelText("GitHub PAT")).toHaveValue("");
  });

  it("shows actionable validation failure message", async () => {
    validateShouldFail = true;
    render(<IntegrationsSettingsPage />);
    const tokenInput = screen.getByLabelText("GitHub PAT");

    fireEvent.change(tokenInput, { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Validate Token" }));

    expect(await screen.findByText("Token missing repo scope")).toBeInTheDocument();
  });

  it("shows actionable save failure message", async () => {
    patchShouldFail = true;
    render(<IntegrationsSettingsPage />);
    const tokenInput = screen.getByLabelText("GitHub PAT");

    fireEvent.change(tokenInput, { target: { value: "ghp_bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Token" }));

    expect(
      await screen.findByText("Save failed: permission denied")
    ).toBeInTheDocument();
  });
});

describe("Settings → Pipeline — global prompt", () => {
  it("renders the global prompt control", async () => {
    render(<PipelineSettingsPage />);
    expect(
      await screen.findByPlaceholderText(
        "Enter global instructions for Claude Code..."
      )
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("settings-save")).toBeDisabled());
  });

  it("loads existing global_prompt value", async () => {
    mockSettings = { global_prompt: "Be concise" };
    render(<PipelineSettingsPage />);

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(
        "Enter global instructions for Claude Code..."
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe("Be concise");
    });
  });

  it("saves global_prompt through the tab footer", async () => {
    render(<PipelineSettingsPage />);

    const textarea = screen.getByPlaceholderText(
      "Enter global instructions for Claude Code..."
    );
    fireEvent.change(textarea, { target: { value: "Use strict TypeScript." } });

    fireEvent.click(screen.getByTestId("settings-save"));

    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0].body).toEqual({ global_prompt: "Use strict TypeScript." });
    });
  });
});
