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
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div data-testid="dropdown-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()} {...rest}>
      {children}
    </button>
  ),
}));

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

import { agentSelectionPatch } from "@/components/chat-page/agent-selection";
import {
  AGENT_SELECT_LOADING_LABEL,
  AgentSelectPill,
  DEFAULT_AGENT_LABEL,
  type AgentSelectMode,
  type AgentSelection,
} from "@/components/shared/AgentSelectPill";
import { ChatWorkspaceHeader } from "@/components/chat/ChatWorkspaceHeader";
import { DeskComposer } from "@/components/desk/DeskComposer";
import {
  PERSISTENT_CHAT_PROVIDER_OPTIONS,
  PROVIDER_OPTIONS,
} from "@/lib/agent-config/constants";
import type { Conversation } from "@/hooks/useConversations";

const NOTHING_SELECTED: AgentSelection = { namedAgentId: null, provider: null };

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

function trigger() {
  return screen.getByTestId("chat-agent-select");
}

function groupLabels(): string[] {
  return screen
    .queryAllByTestId("dropdown-label")
    .map((node) => node.textContent ?? "");
}

beforeEach(() => {
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
          projects={[
            {
              id: "p1",
              name: "Piscine",
              shortName: "PISC",
              colorIndex: 0,
              activeAgents: 0,
              autoModeEnabled: false,
            },
          ]}
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
