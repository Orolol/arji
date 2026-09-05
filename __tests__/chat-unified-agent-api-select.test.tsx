/**
 * Unified Chat Agent & Provider Selection (Epic 0OQJfqU5gZ6S), still pinned
 * after the three menus were merged into one `AgentSelectPill`.
 *
 * The subject moved from `ChatProviderSelect` (deleted) to the header mounting
 * the shared picker, so every case below drives `ChatWorkspaceHeader` — which
 * is what the project panel actually renders.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// The Radix menu portals its items on open; the inline stand-in is what makes
// the option list readable — and its ABSENCE meaningful — in jsdom.
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { dropdownMenuModuleMock } = await import(
    "@/__tests__/helpers/dropdown-menu-mock"
  );
  return dropdownMenuModuleMock();
});

const mockNamedAgents = [
  { id: "agent-1", name: "Claude Code (Sonnet)", provider: "claude-code", model: "claude-3-7-sonnet" },
  { id: "agent-2", name: "Codex (GPT-5)", provider: "codex", model: "gpt-5.3" },
  { id: "agent-3", name: "Oh My Pi (default)", provider: "oh-my-pi", model: "pi-large" },
];

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: mockNamedAgents,
    loading: false,
    refresh: vi.fn(),
  }),
}));

import { ChatWorkspaceHeader } from "@/components/chat/ChatWorkspaceHeader";
import type { Conversation } from "@/hooks/useConversations";

const noop = () => {};

const createConversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: "conv-1",
  projectId: "proj-1",
  type: "brainstorm",
  label: "Brainstorm",
  status: "active",
  epicId: null,
  provider: "claude-code",
  namedAgentId: "agent-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function renderHeader(
  props: Partial<Parameters<typeof ChatWorkspaceHeader>[0]> = {},
) {
  return render(
    <ChatWorkspaceHeader
      activeConversation={createConversation()}
      activeProvider="claude-code"
      hasMessages={false}
      isBusy={false}
      onSelectAgentOrProvider={noop}
      {...props}
    />,
  );
}

/** Every option in the menu, in render order, as `[testid, label]`. */
function options(): [string, string][] {
  return screen
    .getAllByRole("menuitemradio")
    .map((node) => [
      node.getAttribute("data-testid") ?? "",
      node.textContent ?? "",
    ]);
}

describe("Unified Chat Agent & Provider Selection (Epic 0OQJfqU5gZ6S)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders exactly ONE selector in ChatWorkspaceHeader (no secondary grayed-out dropdown)", () => {
    renderHeader();

    const dropdowns = screen.getAllByTestId("chat-agent-select");
    expect(dropdowns).toHaveLength(1);
    expect(dropdowns[0]).not.toBeDisabled();
  });

  it("includes Direct API, Named Agents, Persistent CLI and CLI Providers in the single dropdown", () => {
    renderHeader();

    const ids = options().map(([testid]) => testid);

    expect(ids).toContain("chat-option-openai-compatible");
    expect(ids).toContain("chat-option-agent-agent-1");
    expect(ids).toContain("chat-option-agent-agent-2");
    expect(ids).toContain("chat-option-agent-agent-3");

    // CLI options — exactly the registered set, in order, persistent first.
    const cliOptions = options().filter(([testid]) =>
      testid.startsWith("chat-option-provider-"),
    );
    expect(cliOptions.map(([testid]) => testid)).toEqual([
      "chat-option-provider-claude-code-persistent",
      "chat-option-provider-oh-my-pi-persistent",
      "chat-option-provider-claude-code",
      "chat-option-provider-codex",
      "chat-option-provider-oh-my-pi",
      "chat-option-provider-agy",
    ]);
    expect(cliOptions.map(([, label]) => label)).toEqual([
      "Claude Code — persistent",
      "Oh My Pi — persistent",
      "Claude Code (CLI)",
      "Codex (CLI)",
      "Oh My Pi (CLI)",
      "Antigravity (CLI)",
    ]);

    // Removed providers no longer appear.
    expect(ids).not.toContain("chat-option-provider-gemini-cli");
    expect(ids).not.toContain("chat-option-provider-pi");

    expect(screen.getByTestId("chat-option-openai-compatible")).toHaveTextContent(
      "OpenAI-compatible",
    );
  });

  it("is enabled for both Named Agent conversations and OpenAI-compatible conversations when fresh", () => {
    const { unmount } = renderHeader({
      activeConversation: createConversation({
        namedAgentId: "agent-2",
        provider: "codex",
      }),
      activeProvider: "codex",
    });

    const selectNamed = screen.getByTestId("chat-agent-select");
    expect(selectNamed).not.toBeDisabled();
    expect(selectNamed).toHaveTextContent("Codex (GPT-5)");
    unmount();

    renderHeader({
      activeConversation: createConversation({
        namedAgentId: null,
        provider: "openai-compatible",
      }),
      activeProvider: "openai-compatible",
    });

    const selectOpenAi = screen.getByTestId("chat-agent-select");
    expect(selectOpenAi).not.toBeDisabled();
    expect(selectOpenAi).toHaveTextContent("OpenAI-compatible");
  });

  it("dispatches the correct selection payload when switching to OpenAI-compatible", () => {
    const onSelect = vi.fn();
    renderHeader({
      activeConversation: createConversation({
        namedAgentId: "agent-1",
        provider: "claude-code",
      }),
      onSelectAgentOrProvider: onSelect,
    });

    fireEvent.click(screen.getByTestId("chat-option-openai-compatible"));

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "openai-compatible",
    });
  });

  it("dispatches the correct selection payload when switching to a Named Agent", () => {
    const onSelect = vi.fn();
    renderHeader({
      activeConversation: createConversation({
        namedAgentId: null,
        provider: "openai-compatible",
      }),
      onSelectAgentOrProvider: onSelect,
    });

    fireEvent.click(screen.getByTestId("chat-option-agent-agent-3"));

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: "agent-3",
      provider: "oh-my-pi",
    });
  });

  it("dispatches the correct selection payload when switching to a CLI Provider", () => {
    const onSelect = vi.fn();
    renderHeader({
      activeConversation: createConversation({
        namedAgentId: "agent-1",
        provider: "claude-code",
      }),
      onSelectAgentOrProvider: onSelect,
    });

    fireEvent.click(screen.getByTestId("chat-option-provider-oh-my-pi"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "oh-my-pi",
    });
  });

  it("disables the single selector when the conversation has messages or is busy", () => {
    const { rerender } = renderHeader({ hasMessages: true });

    expect(screen.getByTestId("chat-agent-select")).toBeDisabled();

    rerender(
      <ChatWorkspaceHeader
        activeConversation={createConversation()}
        activeProvider="claude-code"
        hasMessages={false}
        isBusy={true}
        onSelectAgentOrProvider={noop}
      />,
    );

    expect(screen.getByTestId("chat-agent-select")).toBeDisabled();
  });
});
