/** Real Radix Select and roster hook, with only the HTTP response deferred. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("NamedAgentSelect controlled initialization", () => {
  it.each([
    { initial: "a", allowClear: false, empty: false },
    { initial: null, allowClear: false, empty: false },
    { initial: null, allowClear: true, empty: false },
    { initial: "a", allowClear: false, empty: true },
    { initial: null, allowClear: false, empty: true },
  ])("stays controlled across loading and value changes: %j", async ({ initial, allowClear, empty }) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    let answer!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { answer = resolve; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();
    const picker = (value: string | null) => (
      <NamedAgentSelect value={value} onChange={onChange} allowClear={allowClear} aria-label="Agent" />
    );
    // Outside a form: hidden native form inputs are a separate event contract.
    const view = render(picker(initial));
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeDisabled();
    expect(screen.getByRole("combobox")).toHaveTextContent("Loading...");
    expect(fetchMock).toHaveBeenCalledWith("/api/agent-config/named-agents");

    await act(async () => {
      answer(Response.json({ data: empty ? [] : [{
        id: "a", name: "Member", kind: "simple", provider: "codex",
        model: "", members: [], isDefault: false, createdAt: null,
      }] }));
    });
    if (empty) {
      expect(screen.getByRole("combobox")).toBeDisabled();
      expect(screen.getByRole("combobox")).toHaveTextContent("No agents configured");
    } else {
      expect(screen.getByRole("combobox")).toBeEnabled();
      expect(screen.getByRole("combobox")).toHaveTextContent(
        initial ? "Member" : allowClear ? "No agent" : "Select agent",
      );
    }
    view.rerender(picker("a"));
    view.rerender(picker(null));
    view.rerender(picker("a"));
    expect(onChange).not.toHaveBeenCalled();
    const messages = [...errors.mock.calls, ...warnings.mock.calls].map((args) => args.join(" "));
    expect(messages.filter((message) => /uncontrolled.*controlled|controlled.*uncontrolled/i.test(message)))
      .toEqual([]);
  });
});
