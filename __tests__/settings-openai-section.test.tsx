import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SettingsPage from "@/app/settings/integrations/page";

let mockSettings: Record<string, unknown> = {};
let patchCalls: Array<Record<string, unknown>> = [];
let openAiTestResponse: { ok: boolean; status: number; body: Record<string, unknown> } = {
  ok: true,
  status: 200,
  body: { data: { valid: true, model: "llama3.1:latest" } },
};

beforeEach(() => {
  mockSettings = {};
  patchCalls = [];
  openAiTestResponse = {
    ok: true,
    status: 200,
    body: { data: { valid: true, model: "llama3.1:latest" } },
  };

  global.fetch = vi
    .fn()
    .mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === "PATCH") {
        const body = JSON.parse(opts.body as string) as Record<string, unknown>;
        patchCalls.push(body);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { updated: true } }),
        });
      }

      if (url.endsWith("/api/settings/openai/test")) {
        return Promise.resolve({
          ok: openAiTestResponse.ok,
          status: openAiTestResponse.status,
          json: () => Promise.resolve(openAiTestResponse.body),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: mockSettings }),
      });
    });
});

describe("Settings page — OpenAI-compatible API section", () => {
  it("renders the section with Base URL, API key, Model inputs and a Reasoning select", () => {
    render(<SettingsPage />);

    const section = screen.getByTestId("openai-settings");
    expect(within(section).getByTestId("openai-base-url")).toBeInTheDocument();
    expect(within(section).getByTestId("openai-api-key")).toBeInTheDocument();
    expect(within(section).getByTestId("openai-model")).toBeInTheDocument();
    expect(within(section).getByTestId("openai-reasoning-effort")).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Test connection" })
    ).toBeInTheDocument();
  });

  it("saves all four settings keys when Save is clicked", async () => {
    render(<SettingsPage />);

    const section = screen.getByTestId("openai-settings");
    fireEvent.change(within(section).getByTestId("openai-base-url"), {
      target: { value: "http://localhost:11434/v1" },
    });
    fireEvent.change(within(section).getByTestId("openai-api-key"), {
      target: { value: "sk-secret" },
    });
    fireEvent.change(within(section).getByTestId("openai-model"), {
      target: { value: "llama3.1" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByTestId("openai-settings-message")).toHaveTextContent(
        "OpenAI-compatible settings saved."
      );
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toEqual({
      openai_base_url: "http://localhost:11434/v1",
      openai_api_key: "sk-secret",
      openai_model: "llama3.1",
      openai_reasoning_effort: "off",
    });
  });

  it("requires a Base URL and a Model before saving", async () => {
    render(<SettingsPage />);

    const section = screen.getByTestId("openai-settings");
    fireEvent.change(within(section).getByTestId("openai-model"), {
      target: { value: "llama3.1" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByTestId("openai-settings-error")).toHaveTextContent(
        "Base URL is required."
      );
    });
    expect(patchCalls).toHaveLength(0);
  });

  it("shows the saved-key indicator when the settings load with hasToken", async () => {
    mockSettings = {
      openai_base_url: "http://localhost:11434/v1",
      openai_api_key: { hasToken: true },
      openai_model: "llama3.1",
    };

    render(<SettingsPage />);

    await waitFor(() => {
      expect(
        screen.getByTestId("openai-settings").textContent
      ).toContain("An API key is already saved");
    });
    expect(screen.getByTestId("openai-base-url")).toHaveValue(
      "http://localhost:11434/v1"
    );
    expect(screen.getByTestId("openai-model")).toHaveValue("llama3.1");
  });
  it("does not overwrite saved API key when Save is clicked with empty API key input", async () => {
    mockSettings = {
      openai_base_url: "http://localhost:11434/v1",
      openai_api_key: { hasToken: true },
      openai_model: "llama3.1",
      openai_reasoning_effort: "off",
    };

    render(<SettingsPage />);

    const section = screen.getByTestId("openai-settings");
    await waitFor(() => {
      expect(screen.getByTestId("openai-model")).toHaveValue("llama3.1");
    });

    fireEvent.change(within(section).getByTestId("openai-model"), {
      target: { value: "llama3.2" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByTestId("openai-settings-message")).toHaveTextContent(
        "OpenAI-compatible settings saved."
      );
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toEqual({
      openai_base_url: "http://localhost:11434/v1",
      openai_model: "llama3.2",
      openai_reasoning_effort: "off",
    });
  });

  it("allows explicitly clearing the saved API key", async () => {
    mockSettings = {
      openai_base_url: "http://localhost:11434/v1",
      openai_api_key: { hasToken: true },
      openai_model: "llama3.1",
    };

    render(<SettingsPage />);

    const section = screen.getByTestId("openai-settings");
    await waitFor(() => {
      expect(within(section).getByTestId("openai-clear-key-button")).toBeInTheDocument();
    });

    fireEvent.click(within(section).getByTestId("openai-clear-key-button"));

    await waitFor(() => {
      expect(screen.getByTestId("openai-settings-message")).toHaveTextContent(
        "Saved API key cleared."
      );
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toEqual({
      openai_api_key: "",
    });
    expect(within(section).queryByTestId("openai-clear-key-button")).not.toBeInTheDocument();
  });

  it("shows the tested model name on a successful connection test", async () => {
    render(<SettingsPage />);

    const section = screen.getByTestId("openai-settings");
    fireEvent.click(within(section).getByRole("button", { name: "Test connection" }));

    await waitFor(() => {
      expect(screen.getByTestId("openai-settings-message")).toHaveTextContent(
        "Connection successful — model: llama3.1:latest."
      );
    });
  });

  it("disables the Test connection button while the test request is in flight", async () => {
    const { promise, resolve } = Promise.withResolvers<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }>();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/settings/openai/test")) {
        return promise;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: mockSettings }),
      });
    });

    render(<SettingsPage />);

    const section = screen.getByTestId("openai-settings");
    const testButton = within(section).getByRole("button", { name: "Test connection" });
    expect(testButton).not.toBeDisabled();

    fireEvent.click(testButton);

    expect(testButton).toBeDisabled();
    expect(testButton).toHaveTextContent("Testing...");

    resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: { valid: true, model: "llama3.1" } }),
    });

    await waitFor(() => {
      expect(testButton).not.toBeDisabled();
      expect(testButton).toHaveTextContent("Test connection");
    });
  });

  it("shows the readable server error on a failed connection test", async () => {
    openAiTestResponse = {
      ok: false,
      status: 400,
      body: { error: "OpenAI-compatible API error: 401 Unauthorized" },
    };

    render(<SettingsPage />);

    const section = screen.getByTestId("openai-settings");
    fireEvent.click(within(section).getByRole("button", { name: "Test connection" }));

    await waitFor(() => {
      expect(screen.getByTestId("openai-settings-error")).toHaveTextContent(
        "OpenAI-compatible API error: 401 Unauthorized"
      );
    });
  });
});
