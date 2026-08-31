/**
 * Per-project Full Auto agent overrides, in the desk popover.
 *
 * The invariant worth a test: the suffixed `:<projectId>` keys and the bare
 * workspace keys are DIFFERENT settings, and the on/off box and the agent
 * pills must not clobber each other. Both are guaranteed by what each request
 * carries — the route keys off `"buildAgent" in payload` — so the bodies are
 * what these assert.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FullAutoProjectRow } from "@/components/desk/FullAutoProjectRow";

const AGENTS = [
  { id: "a1", name: "Opus Builder", provider: "claude-code" },
  { id: "a2", name: "Codex Reviewer", provider: "codex" },
];

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: AGENTS, loading: false, refresh: vi.fn() }),
}));

const project = (over: Partial<{ autoModeEnabled: boolean }> = {}) => ({
  id: "p1",
  name: "Arij",
  autoModeEnabled: true,
  activeAgents: 0,
  ...over,
});

describe("FullAutoProjectRow", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps the on/off box working and carrying only `enabled`", () => {
    const onToggle = vi.fn();
    render(
      <FullAutoProjectRow
        project={project({ autoModeEnabled: false })}
        onToggle={onToggle}
        onSetAgent={vi.fn()}
      />,
    );

    const box = screen.getByRole("checkbox", { name: /Arij/ });
    expect(box).toHaveAttribute("aria-checked", "false");
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith("p1", true);
  });

  it("shows the effective agents once Full Auto is on", () => {
    render(
      <FullAutoProjectRow
        project={project()}
        onToggle={vi.fn()}
        onSetAgent={vi.fn()}
        agents={{ buildAgent: "a1", reviewAgent: "a2" }}
      />,
    );

    expect(screen.getByRole("button", { name: /Opus Builder/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Codex Reviewer/ })).toBeInTheDocument();
  });

  it("reads an unset override as Default rather than inventing a name", () => {
    render(
      <FullAutoProjectRow
        project={project()}
        onToggle={vi.fn()}
        onSetAgent={vi.fn()}
        agents={{ buildAgent: null, reviewAgent: null }}
      />,
    );
    expect(screen.getAllByRole("button", { name: /Default/ })).toHaveLength(2);
  });

  it("hides the pills while the project's Full Auto is off", () => {
    render(
      <FullAutoProjectRow
        project={project({ autoModeEnabled: false })}
        onToggle={vi.fn()}
        onSetAgent={vi.fn()}
        agents={{ buildAgent: "a1", reviewAgent: null }}
      />,
    );
    expect(screen.queryByRole("button", { name: /Opus Builder/ })).not.toBeInTheDocument();
  });

  it("writes one role at a time, so the other and the enabled flag survive", async () => {
    const onSetAgent = vi.fn();
    render(
      <FullAutoProjectRow
        project={project()}
        onToggle={vi.fn()}
        onSetAgent={onSetAgent}
        agents={{ buildAgent: null, reviewAgent: null }}
      />,
    );

    // Radix opens its menu on pointerdown, which fireEvent.click does not send.
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /Default/ })[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Opus Builder" }));

    await waitFor(() =>
      expect(onSetAgent).toHaveBeenCalledWith("p1", "buildAgent", "a1"),
    );
    expect(onSetAgent).toHaveBeenCalledTimes(1);
  });

  it("clears an override back to the resolution chain", async () => {
    const onSetAgent = vi.fn();
    render(
      <FullAutoProjectRow
        project={project()}
        onToggle={vi.fn()}
        onSetAgent={onSetAgent}
        agents={{ buildAgent: "a1", reviewAgent: null }}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Opus Builder/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Default" }));

    await waitFor(() =>
      expect(onSetAgent).toHaveBeenCalledWith("p1", "buildAgent", null),
    );
  });

  it("renders as the plain on/off row when no override handler is wired", () => {
    render(<FullAutoProjectRow project={project()} onToggle={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: /Arij/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Default/ })).not.toBeInTheDocument();
  });
});
