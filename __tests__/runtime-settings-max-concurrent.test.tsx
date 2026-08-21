/**
 * Tests for the "Max concurrent agents" input in
 * components/agent-config/RuntimeSettingsTab.tsx: scope-aware settings key
 * (agent_max_concurrent / agent_max_concurrent:<projectId>), load, save,
 * clear-to-inherit, and input validation.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { RuntimeSettingsTab } from "@/components/agent-config/RuntimeSettingsTab";

vi.mock("@/hooks/useAgentConfig", () => ({
  useNamedAgents: () => ({ data: [], loading: false }),
}));

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

describe("RuntimeSettingsTab — max concurrent agents input", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  function mockSettingsLoad(data: Record<string, unknown>) {
    fetchMock.mockImplementation((...args: FetchArgs) => {
      const url = String(args[0]);
      if (url.includes("/api/settings") && (!args[1] || !args[1].method)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  }

  it("renders empty with the built-in default (unlimited) as placeholder when unset (global scope)", async () => {
    mockSettingsLoad({});
    render(<RuntimeSettingsTab scope="global" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).not.toBeDisabled());
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Unlimited");
  });

  it("loads the stored global value", async () => {
    mockSettingsLoad({ agent_max_concurrent: 5 });
    render(<RuntimeSettingsTab scope="global" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveValue(5));
  });

  it("saves the global key on the settings API", async () => {
    mockSettingsLoad({});
    render(<RuntimeSettingsTab scope="global" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            String(call[0]).includes("/api/settings") &&
            (call[1]?.method === "PATCH") &&
            (call[1]?.body as string).includes('"agent_max_concurrent":3'),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("agent-max-concurrent-effective").textContent).toContain("saved"));
  });

  it("saves the project-scoped key in project scope", async () => {
    mockSettingsLoad({});
    render(<RuntimeSettingsTab scope="project" projectId="proj-1" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            (call[1]?.method === "PATCH") &&
            (call[1]?.body as string).includes('"agent_max_concurrent:proj-1":2'),
        ),
      ).toBe(true),
    );
  });

  it("keeps Save disabled while pristine and for junk values", async () => {
    mockSettingsLoad({ agent_max_concurrent: 5 });
    render(<RuntimeSettingsTab scope="global" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveValue(5));

    const save = screen.getByText("Save");
    expect(save).toBeDisabled();

    // jsdom sanitizes non-numeric input[type=number] values to "" —
    // use a negative number as the junk case.
    fireEvent.change(input, { target: { value: "-3" } });
    await waitFor(() => expect(save).toBeDisabled());

    fireEvent.change(input, { target: { value: "7" } });
    await waitFor(() => expect(save).not.toBeDisabled());
  });

  it("accepts 0 as unlimited", async () => {
    mockSettingsLoad({});
    render(<RuntimeSettingsTab scope="global" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            (call[1]?.method === "PATCH") &&
            (call[1]?.body as string).includes('"agent_max_concurrent":0'),
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.getByTestId("agent-max-concurrent-effective").textContent).toContain("Unlimited"),
    );
  });

  it("commits on Enter", async () => {
    mockSettingsLoad({});
    render(<RuntimeSettingsTab scope="global" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            (call[1]?.method === "PATCH") &&
            (call[1]?.body as string).includes('"agent_max_concurrent":4'),
        ),
      ).toBe(true),
    );
  });

  it("commits on blur", async () => {
    mockSettingsLoad({});
    render(<RuntimeSettingsTab scope="global" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "6" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            (call[1]?.method === "PATCH") &&
            (call[1]?.body as string).includes('"agent_max_concurrent":6'),
        ),
      ).toBe(true),
    );
  });

  it("clears back to the inherited default when emptied and saved", async () => {
    mockSettingsLoad({ agent_max_concurrent: 5 });
    render(<RuntimeSettingsTab scope="global" />);

    const input = (await screen.findByLabelText("Max concurrent agents")) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveValue(5));
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (call) =>
            (call[1]?.method === "PATCH") &&
            (call[1]?.body as string).includes('"agent_max_concurrent":null'),
        ),
      ).toBe(true),
    );
  });
});
