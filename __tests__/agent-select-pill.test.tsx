/**
 * The one agent picker, in its two modes.
 *
 * The point of the merge is that `dispatch` CANNOT offer what `chat` offers:
 * a build runs neither on the direct API nor on a persistent CLI. That is
 * asserted here as absence from the DOM, which is only a real question because
 * the Radix menu is replaced below by an inline stand-in — the real one
 * portals its items on open, so "not in the DOM" would be vacuously true for
 * every option, in both modes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/ui/dropdown-menu", async () => {
  const { dropdownMenuModuleMock } = await import(
    "@/__tests__/helpers/dropdown-menu-mock"
  );
  return dropdownMenuModuleMock();
});

const namedAgents = vi.hoisted(() => ({
  current: [] as { id: string; name: string; provider: string }[],
  loading: false,
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: namedAgents.current,
    loading: namedAgents.loading,
    refresh: vi.fn(),
  }),
}));

import {
  agentSelectionPatch,
  selectionForConversation,
} from "@/components/chat-page/agent-selection";
import {
  AGENT_SELECT_LOADING_LABEL_KEY,
  AgentSelectPill,
  DEFAULT_AGENT_LABEL_KEY,
  type AgentSelectMode,
  type AgentSelection,
} from "@/components/shared/AgentSelectPill";
import { catalogueValue } from "@/lib/i18n";
import { ChatWorkspaceHeader } from "@/components/chat/ChatWorkspaceHeader";
import { ChatComposer } from "@/components/chat-page/ChatComposer";
import { DeskComposer } from "@/components/desk/DeskComposer";
import {
  PERSISTENT_CHAT_PROVIDER_OPTIONS,
  PROVIDER_OPTIONS,
} from "@/lib/agent-config/constants";
import type { Conversation } from "@/hooks/useConversations";
import type { DeskProject } from "@/lib/control-desk/types";

const NOTHING_SELECTED: AgentSelection = { namedAgentId: null, provider: null };

// The pill exports catalogue KEY REFERENCES; these are the English words the
// suite runs against, resolved once from the same catalogue the mock renders.
const DEFAULT_AGENT_LABEL = catalogueValue("en", DEFAULT_AGENT_LABEL_KEY);
const AGENT_SELECT_LOADING_LABEL = catalogueValue(
  "en",
  AGENT_SELECT_LOADING_LABEL_KEY,
);

function renderPill(
  mode: AgentSelectMode,
  selection: AgentSelection = NOTHING_SELECTED,
  extra: Partial<React.ComponentProps<typeof AgentSelectPill>> = {},
) {
  const onSelect = vi.fn();
  render(
    <AgentSelectPill
      mode={mode}
      selection={selection}
      onSelect={onSelect}
      {...extra}
    />,
  );
  return { onSelect };
}

const DESK_PROJECT: DeskProject = {
  id: "p1",
  name: "Piscine",
  shortName: "PISC",
  colorIndex: 0,
  activeAgents: 0,
  autoModeEnabled: false,
};

/**
 * The desk composer as `NowDesk` mounts it. The mode is NOT a parameter here
 * on purpose: what these tests pin is the composer's own `mode="dispatch"`,
 * which no test reached before — `renderPill` passes the mode in, so it goes
 * on proving `dispatch` behaves while saying nothing about the desk asking
 * for it.
 */
function renderDeskComposer(namedAgentId: string | null = null) {
  const onNamedAgentChange = vi.fn();
  render(
    <DeskComposer
      projects={[DESK_PROJECT]}
      targetProjectId="p1"
      onTargetProjectChange={vi.fn()}
      namedAgentId={namedAgentId}
      onNamedAgentChange={onNamedAgentChange}
      onSubmit={vi.fn()}
    />,
  );
  return { onNamedAgentChange };
}

function trigger() {
  return screen.getByTestId("chat-agent-select");
}

function groupLabels(): string[] {
  return screen
    .queryAllByTestId("dropdown-label")
    .map((node) => node.textContent ?? "");
}

beforeEach(() => {
  // ChatComposer mounts MentionTextarea, which loads the project's documents
  // on mount; without this every render leaves an un-acted update behind.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: [] }),
  }) as unknown as typeof fetch;
  namedAgents.current = [
    { id: "a1", name: "Opus Planner", provider: "claude-code" },
    { id: "a2", name: "Codex Builder", provider: "codex" },
  ];
  namedAgents.loading = false;
});

describe("chat mode", () => {
  it("renders the four groups", () => {
    renderPill("chat");

    expect(groupLabels()).toEqual([
      "Direct API",
      "Named Agents",
      "Persistent CLI",
      "CLI Providers",
    ]);
    expect(screen.getByTestId("chat-option-openai-compatible")).toBeInTheDocument();
    expect(screen.getByTestId("chat-option-agent-a1")).toBeInTheDocument();
    expect(screen.getByTestId("chat-option-agent-a2")).toBeInTheDocument();
    for (const provider of [
      ...PERSISTENT_CHAT_PROVIDER_OPTIONS,
      ...PROVIDER_OPTIONS,
    ]) {
      expect(
        screen.getByTestId(`chat-option-provider-${provider}`),
      ).toBeInTheDocument();
    }
  });

  it("hides the Named Agents group when no agent is configured", () => {
    namedAgents.current = [];
    renderPill("chat");

    expect(groupLabels()).toEqual([
      "Direct API",
      "Persistent CLI",
      "CLI Providers",
    ]);
    // The rest of the menu is untouched: an empty roster is not an empty menu.
    expect(screen.getByTestId("chat-option-openai-compatible")).toBeInTheDocument();
    expect(
      screen.getByTestId("chat-option-provider-claude-code-persistent"),
    ).toBeInTheDocument();
  });

  it("names the persistent modes apart from the raw CLIs", () => {
    renderPill("chat");

    expect(
      screen.getByTestId("chat-option-provider-claude-code-persistent"),
    ).toHaveTextContent("Claude Code — persistent");
    expect(screen.getByTestId("chat-option-provider-claude-code")).toHaveTextContent(
      "Claude Code (CLI)",
    );
  });
});

describe("dispatch mode", () => {
  it("offers the default agent and the named agents, and nothing else", () => {
    renderPill("dispatch");

    expect(screen.getByTestId("chat-option-default-agent")).toHaveTextContent(
      DEFAULT_AGENT_LABEL,
    );
    expect(screen.getByTestId("chat-option-agent-a1")).toBeInTheDocument();
    expect(screen.getByTestId("chat-option-agent-a2")).toBeInTheDocument();
  });

  it("does not put a single chat-only mode in the DOM", () => {
    // A build cannot run on the direct API (chat-only) nor on a persistent CLI
    // (chat-only by construction): offering them here would offer a dispatch
    // the build route cannot honour.
    renderPill("dispatch");

    expect(screen.queryByTestId("chat-option-openai-compatible")).toBeNull();
    for (const provider of PERSISTENT_CHAT_PROVIDER_OPTIONS) {
      expect(screen.queryByTestId(`chat-option-provider-${provider}`)).toBeNull();
    }
    // Raw CLI providers are not dispatchable choices either — the desk sends a
    // named agent id and the route resolves the provider from the agent row.
    for (const provider of PROVIDER_OPTIONS) {
      expect(screen.queryByTestId(`chat-option-provider-${provider}`)).toBeNull();
    }
    expect(screen.queryByText("Direct API")).toBeNull();
    expect(screen.queryByText("Persistent CLI")).toBeNull();
  });

  it("still renders the default entry with an empty agent roster", () => {
    namedAgents.current = [];
    renderPill("dispatch");

    expect(screen.getByTestId("chat-option-default-agent")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-option-agent-a1")).toBeNull();
  });
});

describe("the selection contract", () => {
  it("emits a named agent with its own provider, and PATCHes the agent alone", () => {
    const { onSelect } = renderPill("chat");

    fireEvent.click(screen.getByTestId("chat-option-agent-a2"));

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: "a2",
      provider: "codex",
    });
    // A named agent OWNS its provider: the PATCH route re-derives it from the
    // agent row, so the provider must not travel alongside it.
    expect(agentSelectionPatch(onSelect.mock.calls[0][0])).toEqual({
      namedAgentId: "a2",
    });
  });

  it("emits a raw provider with the named-agent link cleared", () => {
    const { onSelect } = renderPill("chat", {
      namedAgentId: "a1",
      provider: "claude-code",
    });

    fireEvent.click(screen.getByTestId("chat-option-openai-compatible"));

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "openai-compatible",
    });
    expect(agentSelectionPatch(onSelect.mock.calls[0][0])).toEqual({
      provider: "openai-compatible",
      namedAgentId: null,
    });
  });

  it("emits a persistent mode as a provider, not as an agent", () => {
    const { onSelect } = renderPill("chat");

    fireEvent.click(
      screen.getByTestId("chat-option-provider-oh-my-pi-persistent"),
    );

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "oh-my-pi-persistent",
    });
  });

  it("emits the same shape from dispatch mode, with no provider for the default", () => {
    const { onSelect } = renderPill("dispatch", {
      namedAgentId: "a1",
      provider: null,
    });

    fireEvent.click(screen.getByTestId("chat-option-default-agent"));
    expect(onSelect).toHaveBeenCalledWith({ namedAgentId: null, provider: null });
    // Nothing to write: "default" is the server resolving it, not a provider
    // this surface picked.
    expect(agentSelectionPatch(onSelect.mock.calls[0][0])).toBeNull();

    fireEvent.click(screen.getByTestId("chat-option-agent-a1"));
    expect(onSelect).toHaveBeenLastCalledWith({
      namedAgentId: "a1",
      provider: "claude-code",
    });
  });
});

describe("what the trigger says", () => {
  it("keeps the chat-agent-select id by default, in both modes", () => {
    const { unmount } = render(
      <AgentSelectPill mode="chat" selection={NOTHING_SELECTED} onSelect={vi.fn()} />,
    );
    expect(screen.getAllByTestId("chat-agent-select")).toHaveLength(1);
    unmount();

    render(
      <AgentSelectPill
        mode="dispatch"
        selection={NOTHING_SELECTED}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("chat-agent-select")).toHaveLength(1);
  });

  it("takes an id of its own where a page carries two pickers", () => {
    renderPill("dispatch", NOTHING_SELECTED, { testId: "desk-agent-select" });

    expect(screen.getByTestId("desk-agent-select")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-agent-select")).toBeNull();
  });

  it("names the linked agent, the provider, or the mode's own default", () => {
    const { unmount } = render(
      <AgentSelectPill
        mode="chat"
        selection={{ namedAgentId: "a1", provider: "claude-code" }}
        onSelect={vi.fn()}
      />,
    );
    expect(trigger()).toHaveTextContent("Opus Planner");
    unmount();

    const second = render(
      <AgentSelectPill
        mode="chat"
        selection={{ namedAgentId: null, provider: "openai-compatible" }}
        onSelect={vi.fn()}
      />,
    );
    expect(trigger()).toHaveTextContent("OpenAI-compatible");
    second.unmount();

    render(
      <AgentSelectPill
        mode="dispatch"
        selection={NOTHING_SELECTED}
        onSelect={vi.fn()}
      />,
    );
    expect(trigger()).toHaveTextContent(DEFAULT_AGENT_LABEL);
  });

  it("falls back to the stored provider when the linked agent was deleted", () => {
    renderPill("chat", { namedAgentId: "agent-gone", provider: "codex" });
    expect(trigger()).toHaveTextContent("Codex");
  });

  it("labels a provider stored before a cleanup with its raw value", () => {
    // `conversations.provider` is free-form text: a legacy row must still name
    // itself rather than blank the trigger.
    renderPill("chat", {
      namedAgentId: null,
      provider: "gemini-cli" as AgentSelection["provider"],
    });
    expect(trigger()).toHaveTextContent("gemini-cli");
  });

  it("stays on screen while the agent list loads", () => {
    namedAgents.loading = true;
    namedAgents.current = [];
    renderPill("chat", { namedAgentId: "a1", provider: "claude-code" });

    // The trigger is the thing that must not disappear — a picker that pops
    // out and back moves the whole composer row under the cursor.
    expect(trigger()).toBeInTheDocument();
    expect(trigger()).toBeDisabled();
    expect(trigger()).toHaveTextContent(AGENT_SELECT_LOADING_LABEL);
  });

  it("locks on demand", () => {
    renderPill("chat", NOTHING_SELECTED, { disabled: true });
    expect(trigger()).toBeDisabled();
  });
});

describe("the desk composer's own wiring", () => {
  /**
   * `dispatch mode` above proves the MODE. This proves the DESK ASKS FOR IT —
   * a separate claim, and the one that was missing: flipping the composer's
   * own `mode` to `chat` left all 72 tests of this epic green, so the desk
   * could start offering the direct API and the persistent CLIs without a
   * single assertion moving. Those are chat-only modes; a build dispatched on
   * one is a request `epics/[epicId]/build/route.ts` cannot honour.
   */
  it("mounts its picker in dispatch mode — no chat-only mode reaches the desk", () => {
    renderDeskComposer();

    expect(screen.getByTestId("desk-agent-select")).toBeInTheDocument();
    expect(screen.getByTestId("chat-option-default-agent")).toHaveTextContent(
      DEFAULT_AGENT_LABEL,
    );
    expect(screen.getByTestId("chat-option-agent-a1")).toBeInTheDocument();
    expect(screen.getByTestId("chat-option-agent-a2")).toBeInTheDocument();

    expect(screen.queryByTestId("chat-option-openai-compatible")).toBeNull();
    for (const provider of [
      ...PERSISTENT_CHAT_PROVIDER_OPTIONS,
      ...PROVIDER_OPTIONS,
    ]) {
      expect(screen.queryByTestId(`chat-option-provider-${provider}`)).toBeNull();
    }
    // The four chat groups are not merely empty here, they are undrawn.
    expect(groupLabels()).toEqual([]);
  });

  it("hands the desk a named agent id alone — the provider never travels", () => {
    // `NowDesk` POSTs `{ namedAgentId }` or `{}` to the build routes and the
    // route reads nothing else, deriving the provider from the agent row. So
    // the composer's callback carries no provider at all: the picker emits one
    // for display, and the desk drops it here.
    const { onNamedAgentChange } = renderDeskComposer();

    fireEvent.click(screen.getByTestId("chat-option-agent-a2"));
    expect(onNamedAgentChange).toHaveBeenCalledWith("a2");
    expect(onNamedAgentChange).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("chat-option-default-agent"));
    expect(onNamedAgentChange).toHaveBeenLastCalledWith(null);
  });

  it("names the selected agent on the trigger", () => {
    renderDeskComposer("a1");
    expect(screen.getByTestId("desk-agent-select")).toHaveTextContent(
      "Opus Planner",
    );
  });

  it("says the default rather than an em-dash when no agent is chosen", () => {
    // `chat` labels an empty selection "—" because a conversation always runs
    // on something the server already stored. The desk's empty selection means
    // the opposite — nothing was chosen and the route will resolve it — so the
    // dispatch trigger has to say so.
    renderDeskComposer(null);
    expect(screen.getByTestId("desk-agent-select")).toHaveTextContent(
      DEFAULT_AGENT_LABEL,
    );
  });
});

describe("which mode the menu says is running", () => {
  /**
   * The project panel used to draw this menu as a shadcn `Select`, whose
   * items carry `aria-selected` and a check indicator. Merging the three
   * menus onto a `DropdownMenu` turned them into plain `menuitem`s — peers,
   * with nothing marking the conversation's current mode. A screen-reader
   * user opening the picker heard eight equal options; the sighted check
   * mark went the same way. Radio items restore both.
   */
  function checkedOption(): string | null {
    const checked = screen
      .queryAllByRole("menuitemradio")
      .filter((node) => node.getAttribute("aria-checked") === "true");
    expect(checked.length).toBeLessThanOrEqual(1);
    return checked[0]?.getAttribute("data-testid") ?? null;
  }

  it("marks the conversation's persistent mode, and only it", () => {
    renderPill("chat", {
      namedAgentId: null,
      provider: "oh-my-pi-persistent",
    });

    expect(checkedOption()).toBe("chat-option-provider-oh-my-pi-persistent");
  });

  it("marks the linked named agent rather than its provider", () => {
    // The agent's provider is claude-code, which also has its own raw-CLI
    // item; checking that one would name the wrong thing as running.
    renderPill("chat", { namedAgentId: "a1", provider: "claude-code" });

    expect(checkedOption()).toBe("chat-option-agent-a1");
  });

  it("marks the default entry on a dispatch surface with no agent chosen", () => {
    renderPill("dispatch", NOTHING_SELECTED);

    expect(checkedOption()).toBe("chat-option-default-agent");
  });

  it("marks nothing when the stored provider has no item left in the menu", () => {
    // A value written before a provider cleanup. The trigger still labels it
    // (see above); the menu must not check a neighbour to fake a match.
    renderPill("chat", { namedAgentId: null, provider: "gemini-cli" });

    expect(checkedOption()).toBeNull();
  });

  it("gives every option the radio role, in both modes", () => {
    renderPill("chat");
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
    expect(screen.getAllByRole("menuitemradio").length).toBeGreaterThan(0);
  });
});

describe("the chat page composer's own wiring", () => {
  /**
   * The mirror of the desk block above, in the other direction. `/chat` is
   * where the new `claude-code-persistent` default is CHANGED, so it is the
   * one surface that must keep every chat mode reachable — and nothing
   * asserted that it asks for `mode="chat"`. Its own test file renders the
   * real Radix menu, which portals nothing while closed, so the claim can
   * only be made here, against the inline stand-in.
   */
  async function renderChatComposer() {
    const onSelectAgent = vi.fn();
    await act(async () => {
      render(
        <ChatComposer
          projectId="p1"
          projects={[DESK_PROJECT]}
          project={DESK_PROJECT}
          onSelectProject={vi.fn()}
          agentSelection={{ namedAgentId: "a1", provider: "claude-code" }}
          onSelectAgent={onSelectAgent}
          agentLocked={false}
          onSend={vi.fn()}
        />,
      );
    });
    return { onSelectAgent };
  }

  it("mounts its picker in chat mode — all four groups reach /chat", async () => {
    await renderChatComposer();

    expect(groupLabels()).toEqual([
      "Direct API",
      "Named Agents",
      "Persistent CLI",
      "CLI Providers",
    ]);
    expect(screen.getByTestId("chat-option-openai-compatible")).toBeInTheDocument();
    for (const provider of PERSISTENT_CHAT_PROVIDER_OPTIONS) {
      expect(
        screen.getByTestId(`chat-option-provider-${provider}`),
      ).toBeInTheDocument();
    }
    // The dispatch-only entry is the tell: its presence would mean the
    // composer had been flipped to the desk's mode.
    expect(screen.queryByTestId("chat-option-default-agent")).toBeNull();
  });

  it("emits a chat-only mode the desk could never offer", async () => {
    const { onSelectAgent } = await renderChatComposer();

    fireEvent.click(
      screen.getByTestId("chat-option-provider-claude-code-persistent"),
    );
    expect(onSelectAgent).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "claude-code-persistent",
    });
  });
});

describe("one conversation, one selection", () => {
  /**
   * The chat page and the project panel each used to build the selection by
   * hand from `provider` + `namedAgentId`, casting a free-form text column to
   * the narrow union on the way. Two copies of a mapping is how a label rule
   * drifts: rename a provider, touch one copy, and the two surfaces then name
   * the same conversation differently with nothing comparing them. This is
   * that comparison.
   */
  function conversationOn(provider: string, namedAgentId: string | null = null): Conversation {
    return {
      id: "conv-1",
      projectId: "p1",
      type: "chat",
      label: "Chat",
      status: "active",
      epicId: null,
      provider,
      namedAgentId,
      createdAt: "2026-01-01",
    };
  }

  it("reads a stored conversation without asserting anything about its provider", () => {
    // A value written before a provider cleanup: not in the union, not in the
    // menu, and it must still survive the trip to the trigger.
    expect(selectionForConversation(conversationOn("gemini-cli"))).toEqual({
      namedAgentId: null,
      provider: "gemini-cli",
    });
    expect(selectionForConversation(conversationOn("codex", "a2"))).toEqual({
      namedAgentId: "a2",
      provider: "codex",
    });
    expect(selectionForConversation(null)).toEqual({
      namedAgentId: null,
      provider: null,
    });
  });

  it.each([
    ["a linked named agent", conversationOn("claude-code", "a1"), "Opus Planner"],
    ["a persistent mode", conversationOn("oh-my-pi-persistent"), "Oh My Pi — persistent"],
    ["a provider dropped in a cleanup", conversationOn("gemini-cli"), "gemini-cli"],
  ])("names %s the same on both chat surfaces", async (_case, conversation, expected) => {
    await act(async () => {
      render(
        <>
          <ChatComposer
            projectId="p1"
            projects={[DESK_PROJECT]}
            project={DESK_PROJECT}
            onSelectProject={vi.fn()}
            agentSelection={selectionForConversation(conversation)}
            onSelectAgent={vi.fn()}
            agentLocked={false}
            onSend={vi.fn()}
          />
          <ChatWorkspaceHeader
            activeConversation={conversation}
            activeProvider={conversation.provider}
            hasMessages={false}
            isBusy={false}
            onSelectAgentOrProvider={vi.fn()}
          />
        </>,
      );
    });

    // Both are `chat-agent-select` — the two chat surfaces share the id, and
    // only the desk overrides it. So the query returns both pills, and the
    // point is that they read the same without a second hand-written mapping.
    const triggers = screen.getAllByTestId("chat-agent-select");
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toHaveTextContent(expected);
    expect(triggers[1].textContent).toBe(triggers[0].textContent);
  });
});

describe("the two pickers `/projects/:id` mounts at once", () => {
  /**
   * The project route draws the desk composer AND the chat panel's header, so
   * one shared trigger id there resolves to two elements — `getByTestId` throws
   * and a Playwright locator fails strict mode. Caught in real Chrome on
   * `/projects/:id`; pinned here on the two components that page mounts, which
   * is a claim about them and not about the page's own render tree.
   */
  it("give their triggers different ids", () => {
    const conversation: Conversation = {
      id: "conv-1",
      projectId: "p1",
      type: "chat",
      label: "Chat",
      status: "active",
      epicId: null,
      provider: "claude-code",
      namedAgentId: null,
      createdAt: "2026-01-01",
    };

    render(
      <>
        <DeskComposer
          projects={[DESK_PROJECT]}
          targetProjectId="p1"
          onTargetProjectChange={vi.fn()}
          namedAgentId={null}
          onNamedAgentChange={vi.fn()}
          onSubmit={vi.fn()}
        />
        <ChatWorkspaceHeader
          activeConversation={conversation}
          activeProvider="claude-code"
          hasMessages={false}
          isBusy={false}
          onSelectAgentOrProvider={vi.fn()}
        />
      </>,
    );

    expect(screen.getAllByTestId("desk-agent-select")).toHaveLength(1);
    expect(screen.getAllByTestId("chat-agent-select")).toHaveLength(1);
  });
});
