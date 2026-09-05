/**
 * The project panel's meta cluster, after the three agent menus were merged.
 *
 * This file used to drive `ChatProviderSelect` — a shadcn `Select` this
 * surface drew on its own. That component is gone: the header now mounts the
 * shared `AgentSelectPill` in `chat` mode, so what is left to pin here is the
 * WIRING (which selection the header derives from the conversation, when it is
 * locked) rather than the menu's contents, which belong to
 * `agent-select-pill.test.tsx`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Inline stand-in for the Radix menu: it portals on open, and these tests read
// the items without opening anything.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { dropdownMenuModuleMock } = await import(
    "@/__tests__/helpers/dropdown-menu-mock"
  );
  return dropdownMenuModuleMock();
});

let mockAgents = [
  { id: "agent-1", name: "Claude Code", provider: "claude-code", model: "sonnet" },
  { id: "agent-2", name: "Codex", provider: "codex", model: "gpt-5.3" },
];

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: mockAgents,
    loading: false,
    refresh: vi.fn(),
  }),
}));

import { ChatWorkspaceHeader } from "@/components/chat/ChatWorkspaceHeader";
import type { Conversation } from "@/hooks/useConversations";

const noop = () => {};

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: "conv1",
  projectId: "proj1",
  type: "chat",
  label: "Chat",
  status: "active",
  epicId: null,
  provider: "claude-code",
  namedAgentId: null,
  createdAt: "2026-01-01",
  ...overrides,
});

function renderHeader(
  props: Partial<Parameters<typeof ChatWorkspaceHeader>[0]> = {},
) {
  return render(
    <ChatWorkspaceHeader
      activeConversation={conversation()}
      activeProvider="claude-code"
      hasMessages={false}
      isBusy={false}
      onSelectAgentOrProvider={noop}
      {...props}
    />,
  );
}

function picker() {
  return screen.getByTestId("chat-agent-select");
}

describe("the header's agent picker", () => {
  beforeEach(() => {
    mockAgents = [
      { id: "agent-1", name: "Claude Code", provider: "claude-code", model: "sonnet" },
      { id: "agent-2", name: "Codex", provider: "codex", model: "gpt-5.3" },
    ];
  });

  it("mounts the shared picker in chat mode — direct API, agents, persistent CLIs", () => {
    renderHeader();

    expect(screen.getByTestId("chat-option-openai-compatible")).toBeInTheDocument();
    expect(screen.getByTestId("chat-option-agent-agent-1")).toBeInTheDocument();
    expect(screen.getByTestId("chat-option-agent-agent-2")).toBeInTheDocument();
    expect(
      screen.getByTestId("chat-option-provider-claude-code-persistent"),
    ).toBeInTheDocument();
  });

  it("renders exactly one picker, not a second disabled one", () => {
    renderHeader();
    expect(screen.getAllByTestId("chat-agent-select")).toHaveLength(1);
    expect(picker()).not.toBeDisabled();
  });

  it("names the conversation's linked named agent", () => {
    renderHeader({
      activeConversation: conversation({ namedAgentId: "agent-2", provider: "codex" }),
    });
    expect(picker()).not.toBeDisabled();
    expect(picker()).toHaveTextContent("Codex");
  });

  it("falls back to the stored provider when the linked named agent was deleted", () => {
    renderHeader({
      activeConversation: conversation({
        namedAgentId: "agent-gone",
        provider: "openai-compatible",
      }),
    });
    expect(picker()).toHaveTextContent("OpenAI-compatible");
  });

  it("reports the chosen agent and provider through onSelectAgentOrProvider", () => {
    const onSelect = vi.fn();
    renderHeader({ onSelectAgentOrProvider: onSelect });

    fireEvent.click(screen.getByTestId("chat-option-openai-compatible"));
    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "openai-compatible",
    });

    fireEvent.click(screen.getByTestId("chat-option-agent-agent-2"));
    expect(onSelect).toHaveBeenLastCalledWith({
      namedAgentId: "agent-2",
      provider: "codex",
    });

    fireEvent.click(
      screen.getByTestId("chat-option-provider-oh-my-pi-persistent"),
    );
    expect(onSelect).toHaveBeenLastCalledWith({
      namedAgentId: null,
      provider: "oh-my-pi-persistent",
    });
  });

  it("locks once the conversation has messages", () => {
    renderHeader({ hasMessages: true });
    expect(picker()).toBeDisabled();
  });

  it("locks while the conversation is busy", () => {
    renderHeader({ isBusy: true });
    expect(picker()).toBeDisabled();
  });

  it("locks when no conversation is active", () => {
    renderHeader({ activeConversation: null });
    expect(picker()).toBeDisabled();
  });
});

describe("the header's session state", () => {
  it("shows warm/cold state and exposes a restart action", () => {
    const onRestart = vi.fn();
    const { rerender } = renderHeader({
      activeConversation: conversation({
        provider: "claude-code-persistent",
        persistentSessionState: "cold",
      }),
      activeProvider: "claude-code-persistent",
      onRestartPersistentSession: onRestart,
    });

    expect(screen.getByTestId("persistent-session-state")).toHaveTextContent(
      "session cold",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Restart persistent chat session",
      }),
    );
    expect(onRestart).toHaveBeenCalledTimes(1);

    rerender(
      <ChatWorkspaceHeader
        activeConversation={conversation({
          provider: "claude-code-persistent",
          persistentSessionState: "hot",
        })}
        activeProvider="claude-code-persistent"
        hasMessages
        isBusy={false}
        onSelectAgentOrProvider={noop}
        onRestartPersistentSession={onRestart}
      />,
    );
    expect(screen.getByTestId("persistent-session-state")).toHaveTextContent(
      "session warm",
    );
  });

  it("keeps the session-linked badge for non-persistent conversations", () => {
    // Warm/cold replaced this indicator for persistent providers only; an
    // ordinary CLI conversation still resumes from its stored session id.
    renderHeader({
      activeConversation: conversation({
        provider: "claude-code",
        cliSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    });
    expect(screen.getByTestId("linked-session-state")).toHaveTextContent(
      "session linked",
    );
    expect(screen.queryByTestId("persistent-session-state")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Restart persistent chat session" }),
    ).toBeNull();
  });

  it("keeps restart reachable while the conversation is busy", () => {
    // Restarting the embedded CLI is the recovery for a wedged turn, and a
    // wedged turn is precisely when the conversation stays busy.
    const onRestart = vi.fn();
    renderHeader({
      activeConversation: conversation({
        provider: "oh-my-pi-persistent",
        persistentSessionState: "hot",
      }),
      activeProvider: "oh-my-pi-persistent",
      isBusy: true,
      onRestartPersistentSession: onRestart,
    });

    const restart = screen.getByRole("button", {
      name: "Restart persistent chat session",
    });
    expect(restart).not.toBeDisabled();
    fireEvent.click(restart);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
