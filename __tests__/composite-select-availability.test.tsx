/** Real Radix controls and stats hook; only roster/assignment data and HTTP are stubbed. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { agents } = vi.hoisted(() => ({ agents: [
  { id: "c", name: "Empty list", kind: "composite", provider: "composite", model: "", members: [], isDefault: false, options: {}, personaPrompt: null, createdAt: null },
  { id: "m", name: "Member", kind: "simple", provider: "codex", model: "", members: [], isDefault: false, options: {}, personaPrompt: null, createdAt: null },
] }));
vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents, loading: false }),
}));
vi.mock("@/hooks/useAgentConfig", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAgentConfig")>();
  return { ...actual,
    useNamedAgents: () => ({ data: agents, loading: false }),
    useAgentRosterStats: () => ({ data: {}, status: "ready" }),
    useAgentAssignments: () => ({ data: [], loading: false }),
  };
});
vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: () => ({ providers: { codex: true }, loading: false }),
}));

import { NamedAgentSelect } from "@/components/shared/NamedAgentSelect";
import { AgentSelectPill } from "@/components/shared/AgentSelectPill";
import { AgentsWorkshopView } from "@/components/agents-workshop/AgentsWorkshopView";

const pointerCapture = Object.getOwnPropertyDescriptor(Element.prototype, "hasPointerCapture");
const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
beforeEach(() => {
  // jsdom omits these browser APIs; keep the actual Radix controls.
  Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: null })));
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  for (const [key, descriptor] of [["hasPointerCapture", pointerCapture], ["scrollIntoView", scrollIntoView]] as const) {
    if (descriptor) Object.defineProperty(Element.prototype, key, descriptor);
    else Reflect.deleteProperty(Element.prototype, key);
  }
});

it("NamedAgentSelect refuses an empty composite while a simple member remains selectable", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<NamedAgentSelect value={null} onChange={onChange} aria-label="Agent" />);
  await user.click(screen.getByRole("combobox"));
  const empty = screen.getByRole("option", { name: /Empty list/ });
  expect(empty).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(empty);
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("option", { name: "Member" }));
  expect(onChange).toHaveBeenCalledWith("m");
});

it.each(["chat", "dispatch"] as const)("AgentSelectPill refuses empty composites in %s mode", async (mode) => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<AgentSelectPill mode={mode} selection={{ namedAgentId: null, provider: null }} onSelect={onSelect} />);
  await user.click(screen.getByRole("button"));
  const empty = screen.getByRole("menuitemradio", { name: /Empty list/ });
  expect(empty).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(empty);
  expect(onSelect).not.toHaveBeenCalled();
  await user.click(screen.getByRole("menuitemradio", { name: "Member" }));
  expect(onSelect).toHaveBeenCalledWith({ namedAgentId: "m", provider: "codex" });
});

it("workshop fetches per-agent stats only when a simple agent is selected", async () => {
  render(<AgentsWorkshopView />);
  expect(screen.getByLabelText("Name")).toHaveValue("Empty list");
  expect(fetch).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Member" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/agent-config/named-agents/m/stats"));
  await userEvent.click(screen.getByRole("button", { name: "Empty list" }));
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["/api/agent-config/named-agents/m/stats"]);
});
