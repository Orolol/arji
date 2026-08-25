/**
 * Tests for the "Reviewer must differ from builder" toggle in
 * components/agent-config/RuntimeSettingsTab.tsx.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { RuntimeSettingsTab } from "@/components/agent-config/RuntimeSettingsTab";

describe("RuntimeSettingsTab — review provider segregation toggle", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation((...args: unknown[]) => {
      const url = String(args[0]);
      const init = args[1] as RequestInit | undefined;
      if (url.includes("/api/settings") && !init?.method) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: {} }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  it("renders the toggle unchecked by default (setting absent)", async () => {
    render(<RuntimeSettingsTab scope="global" />);

    expect(
      screen.getByText("Reviewer must differ from builder"),
    ).toBeTruthy();
    const checkbox = screen.getByRole("checkbox");
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(checkbox).toHaveAttribute("aria-checked", "false");
  });

  it("saves 'true' to the settings API when toggled on", async () => {
    render(<RuntimeSettingsTab scope="global" />);

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).includes("/api/settings") &&
            (call[1] as RequestInit | undefined)?.method === "PATCH" &&
            (call[1] as RequestInit).body ===
              JSON.stringify({ review_provider_segregation: "true" }),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(checkbox).toHaveAttribute("aria-checked", "true"));
  });

  it("saves 'false' when toggled back off", async () => {
    render(<RuntimeSettingsTab scope="global" />);

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).includes("/api/settings") &&
            (call[1] as RequestInit | undefined)?.method === "PATCH" &&
            (call[1] as RequestInit).body ===
              JSON.stringify({ review_provider_segregation: "false" }),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(checkbox).toHaveAttribute("aria-checked", "false"));
  });
});
