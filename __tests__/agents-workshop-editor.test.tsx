/**
 * The /agents workshop editor.
 *
 * What is pinned here is the behaviour a rewrite loses: per-agent drafts that
 * survive a roster click, the six-field save payload, the two halves of a CLI
 * change (drop ghost options AND clear a cross-provider escalation), the
 * server's error text surfacing verbatim, the persona cap read from the
 * constant, and a delete that only happens after a confirmation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

import {
  agentInitials,
  agentTone,
} from "@/components/agents-workshop/agent-initials";
import { PERSONA_PROMPT_MAX_CHARS } from "@/lib/agent-config/constants";

const state = vi.hoisted(() => ({
  agents: [] as unknown[],
  assignments: [] as unknown[],
  updateNamedAgent: vi.fn(),
  deleteNamedAgent: vi.fn(),
  createNamedAgent: vi.fn(),
  assignAgent: vi.fn(),
}));

vi.mock("@/hooks/useAgentConfig", () => ({
  useNamedAgents: () => ({
    data: state.agents,
    loading: false,
    refresh: vi.fn(),
    createNamedAgent: state.createNamedAgent,
    updateNamedAgent: state.updateNamedAgent,
    deleteNamedAgent: state.deleteNamedAgent,
  }),
  // "ready" with an empty map is the honest shape for a roster whose agents
  // have not run today; the em-dash-vs-zero distinction itself is pinned in
  // __tests__/agents-workshop-roster-stats.test.tsx.
  useAgentRosterStats: () => ({ data: {}, status: "ready", refresh: vi.fn() }),
  useNamedAgentStats: () => ({ data: null, loading: false }),
  useAgentAssignments: () => ({
    data: state.assignments,
    loading: false,
    refresh: vi.fn(),
    assignAgent: state.assignAgent,
  }),
}));

vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: () => ({
    providers: {
      "claude-code": true,
      codex: true,
      "oh-my-pi": true,
      agy: true,
    },
    loading: false,
  }),
}));

/**
 * Radix's popper is not drivable in jsdom, so the menu renders inline. Items
 * become `menuitem` buttons, which keeps them distinguishable from the page's
 * real buttons.
 */
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children?: ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
}));

// The route file is a server component that only awaits `searchParams` and
// hands the scope down; the view below is everything the page renders.
const { AgentsWorkshopView } = await import(
  "@/components/agents-workshop/AgentsWorkshopView"
);

const OPUS = {
  id: "agent-1",
  name: "Opus Builder",
  provider: "claude-code" as const,
  model: "claude-opus-5",
  options: { effort: "max" },
  personaPrompt: "You're an experienced developer.",
  escalatesTo: "agent-3",
  createdAt: "2026-08-01T10:00:00.000Z",
};
const CODEX = {
  id: "agent-2",
  name: "Codex Fast",
  provider: "codex" as const,
  model: "",
  options: {},
  personaPrompt: null,
  escalatesTo: null,
  createdAt: null,
};
const STRONG = {
  id: "agent-3",
  name: "Strong Claude",
  provider: "claude-code" as const,
  model: "claude-opus-5-max",
  options: {},
  personaPrompt: null,
  escalatesTo: null,
  createdAt: null,
};

/** Roster-scoped queries: an agent's name also appears in assignment menus. */
function roster(): HTMLElement {
  return screen.getByTestId("agent-roster");
}

function cliGroup(): HTMLElement {
  const kicker = screen.getByText("CLI", {
    selector: '[data-slot="field-kicker"]',
  });
  return kicker.parentElement as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.agents = [OPUS, CODEX, STRONG];
  state.assignments = [
    {
      agentType: "build",
      provider: "claude-code",
      namedAgentId: "agent-1",
      source: "global",
      scope: "global",
      namedAgent: { id: "agent-1", name: "Opus Builder", provider: "claude-code", model: "" },
    },
  ];
  state.updateNamedAgent.mockResolvedValue({ ok: true });
  state.deleteNamedAgent.mockResolvedValue(true);
  state.createNamedAgent.mockResolvedValue({ ok: true });
  state.assignAgent.mockResolvedValue({ ok: true });
});

describe("agents workshop editor", () => {
  it("opens on the first agent and populates every identity field", () => {
    render(<AgentsWorkshopView />);

    expect(screen.getByLabelText("Name")).toHaveValue("Opus Builder");
    expect(screen.getByLabelText("Model")).toHaveValue("claude-opus-5");
    expect(screen.getByLabelText("Persona")).toHaveValue(
      "You're an experienced developer.",
    );
    expect(within(cliGroup()).getByRole("button")).toHaveTextContent(
      "Claude Code",
    );
  });

  it("switches the editor when another roster card is picked", () => {
    render(<AgentsWorkshopView />);

    fireEvent.click(within(roster()).getByRole("button", { name: "Codex Fast" }));

    expect(screen.getByLabelText("Name")).toHaveValue("Codex Fast");
    expect(screen.getByLabelText("Model")).toHaveValue("");
    // A null persona is an empty field, not the string "null".
    expect(screen.getByLabelText("Persona")).toHaveValue("");
  });

  it("keeps Save disabled until something changes, then sends all six fields", async () => {
    render(<AgentsWorkshopView />);

    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Opus Builder v2  " },
    });
    expect(save).toBeEnabled();

    fireEvent.click(save);

    await waitFor(() =>
      expect(state.updateNamedAgent).toHaveBeenCalledTimes(1),
    );
    expect(state.updateNamedAgent).toHaveBeenCalledWith("agent-1", {
      // Trimmed on the way out; the server stores the trimmed value.
      name: "Opus Builder v2",
      provider: "claude-code",
      model: "claude-opus-5",
      options: { effort: "max" },
      personaPrompt: "You're an experienced developer.",
      escalatesTo: "agent-3",
    });
  });

  it("refuses to save a name that is only whitespace", () => {
    render(<AgentsWorkshopView />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "   " },
    });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("drops ghost options and a cross-provider escalation when the CLI changes", async () => {
    render(<AgentsWorkshopView />);

    const codexItem = within(cliGroup())
      .getAllByRole("menuitem")
      .find((item) => item.textContent?.startsWith("Codex"))!;
    fireEvent.click(codexItem);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(state.updateNamedAgent).toHaveBeenCalledTimes(1),
    );
    const payload = state.updateNamedAgent.mock.calls[0][1];
    // `effort` is a claude-code key codex never declares.
    expect(payload.options).toEqual({});
    // agent-3 is claude-code; keeping the edge would make the agent
    // permanently unsaveable over a field the user never touched.
    expect(payload.escalatesTo).toBe(null);
    expect(payload.provider).toBe("codex");
  });

  it("renders the server's error text verbatim in an alert", async () => {
    state.updateNamedAgent.mockResolvedValue({
      ok: false,
      error: "name already exists",
    });
    render(<AgentsWorkshopView />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Codex Fast" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("name already exists");
  });

  it("caps the persona at the constant, never at a copied number", () => {
    render(<AgentsWorkshopView />);

    expect(screen.getByLabelText("Persona")).toHaveAttribute(
      "maxlength",
      String(PERSONA_PROMPT_MAX_CHARS),
    );
  });

  it("preserves an unsaved draft across a roster round trip", () => {
    render(<AgentsWorkshopView />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Opus Builder EDITED" },
    });

    fireEvent.click(within(roster()).getByRole("button", { name: "Codex Fast" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Codex Fast");

    // The roster keeps the SAVED name — an unsaved rename must not relabel the
    // card the user is looking for; the UNSAVED word is what marks it instead.
    fireEvent.click(within(roster()).getByRole("button", { name: "Opus Builder" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Opus Builder EDITED");
  });

  it("drops the draft again on Discard", () => {
    render(<AgentsWorkshopView />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Opus Builder EDITED" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getByLabelText("Name")).toHaveValue("Opus Builder");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("deletes only after the confirmation is accepted", async () => {
    render(<AgentsWorkshopView />);

    fireEvent.click(screen.getByRole("button", { name: "Delete agent" }));
    expect(state.deleteNamedAgent).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete this agent?");
    // The one consequence a user cannot see, stated in the copy.
    expect(dialog).toHaveTextContent(
      "Assignments pointing at it fall back to the Arij default.",
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete agent" }),
    );
    await waitFor(() =>
      expect(state.deleteNamedAgent).toHaveBeenCalledWith("agent-1"),
    );
  });

  it("collapses to one line, and no bands, with an empty roster", () => {
    state.agents = [];
    render(<AgentsWorkshopView />);

    expect(
      screen.getByText("No agents yet — create your first one on the left."),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-slot="strata-band"]')).toBeNull();
    // The create card and the CLI inventory are still there.
    expect(screen.getByText("Add agent")).toBeInTheDocument();
    expect(screen.getByText("CLIS ON THIS MACHINE")).toBeInTheDocument();
  });

  it("creates an agent from name and provider ONLY", async () => {
    render(<AgentsWorkshopView />);

    fireEvent.click(screen.getByText("Add agent"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Fast builder"), {
      target: { value: "  Fast builder  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));

    await waitFor(() =>
      expect(state.createNamedAgent).toHaveBeenCalledTimes(1),
    );
    // No personaPrompt: an absent one applies the product default, while an
    // explicit "" would create a persona-less agent nobody asked for.
    expect(state.createNamedAgent).toHaveBeenCalledWith({
      name: "Fast builder",
      provider: "claude-code",
    });
  });
});

describe("roster avatar", () => {
  it("takes initials from words first, then from a single word", () => {
    expect(agentInitials("Opus Builder")).toBe("OB");
    expect(agentInitials("fast-review agent")).toBe("FR");
    expect(agentInitials("opus")).toBe("Op");
    expect(agentInitials("  ")).toBe("??");
  });

  it("gives an agent a stable pastel without storing one", () => {
    // Decoration, not identity: agents have no colour column and must not get
    // one, so the tone is a hash — stable across reloads, meaningless as data.
    expect(agentTone("agent-1")).toBe(agentTone("agent-1"));
    for (const id of ["a", "b", "c", "d", "agent-42"]) {
      expect([1, 2, 3, 4]).toContain(agentTone(id));
    }
  });
});
