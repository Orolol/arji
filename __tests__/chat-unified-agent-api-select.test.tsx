import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// Mock Radix Select with native HTML select for testability
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
    disabled,
  }: {
    value: string | undefined;
    onValueChange?: (v: string) => void;
    children: ReactNode;
    disabled?: boolean;
  }) => (
    <select
      data-testid="chat-agent-select"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectLabel: ({ children }: { children: ReactNode }) => <optgroup label={String(children)} />,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => <option value={value}>{children}</option>,
}));

let mockNamedAgents = [
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
import { ChatProviderSelect } from "@/components/chat/ChatProviderSelect";
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

describe("Unified Chat Agent & Provider Selection (Epic 0OQJfqU5gZ6S)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders exactly ONE selector dropdown in ChatWorkspaceHeader (no secondary grayed-out dropdown)", () => {
    render(
      <ChatWorkspaceHeader
        activeConversation={createConversation()}
        activeProvider="claude-code"
        hasMessages={false}
        isBusy={false}
        onSelectAgentOrProvider={noop}
      />,
    );

    const dropdowns = screen.getAllByTestId("chat-agent-select");
    expect(dropdowns).toHaveLength(1);
    expect(dropdowns[0]).not.toBeDisabled();
  });

  it("includes Direct API, Named Agents, and CLI Providers in the single dropdown", () => {
    render(
      <ChatProviderSelect activeConversation={createConversation()} onSelect={noop} />,
    );

    const select = screen.getByTestId("chat-agent-select") as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((opt) => opt.value);

    // Direct API is present
    expect(optionValues).toContain("openai-compatible");

    // All named agents are present
    expect(optionValues).toContain("agent-1");
    expect(optionValues).toContain("agent-2");
    expect(optionValues).toContain("agent-3");

    // CLI providers are present — exactly the registered trio, in order.
    const namedAgentIds = new Set(mockNamedAgents.map((a) => a.id));
    const cliOptions = Array.from(select.options).filter(
      (opt) => opt.value !== "openai-compatible" && !namedAgentIds.has(opt.value),
    );
    expect(cliOptions.map((opt) => opt.value)).toEqual([
      "claude-code-persistent",
      "claude-code",
      "codex",
      "oh-my-pi",
      "agy",
    ]);
    expect(cliOptions.map((opt) => opt.textContent)).toEqual([
      "Claude Code — persistent",
      "Claude Code (CLI)",
      "Codex (CLI)",
      "Oh My Pi (CLI)",
      "Antigravity (CLI)",
    ]);

    // Removed providers no longer appear.
    expect(optionValues).not.toContain("gemini-cli");
    expect(optionValues).not.toContain("pi");

    // Check label for OpenAI-compatible
    const openAiOption = Array.from(select.options).find((opt) => opt.value === "openai-compatible");
    expect(openAiOption?.textContent).toBe("OpenAI-compatible");
  });
  it("is enabled for both Named Agent conversations and OpenAI-compatible conversations when fresh", () => {
    // With Named Agent assigned
    const { unmount } = render(
      <ChatWorkspaceHeader
        activeConversation={createConversation({ namedAgentId: "agent-2", provider: "codex" })}
        activeProvider="codex"
        hasMessages={false}
        isBusy={false}
        onSelectAgentOrProvider={noop}
      />,
    );

    const selectNamed = screen.getByTestId("chat-agent-select") as HTMLSelectElement;
    expect(selectNamed).not.toBeDisabled();
    expect(selectNamed.value).toBe("agent-2");
    unmount();

    // With OpenAI-compatible assigned
    render(
      <ChatWorkspaceHeader
        activeConversation={createConversation({ namedAgentId: null, provider: "openai-compatible" })}
        activeProvider="openai-compatible"
        hasMessages={false}
        isBusy={false}
        onSelectAgentOrProvider={noop}
      />,
    );

    const selectOpenAi = screen.getByTestId("chat-agent-select") as HTMLSelectElement;
    expect(selectOpenAi).not.toBeDisabled();
    expect(selectOpenAi.value).toBe("openai-compatible");
  });

  it("dispatches correct selection payload when switching to OpenAI-compatible", () => {
    const onSelect = vi.fn();
    render(
      <ChatProviderSelect
        activeConversation={createConversation({ namedAgentId: "agent-1", provider: "claude-code" })}
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByTestId("chat-agent-select"), {
      target: { value: "openai-compatible" },
    });

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "openai-compatible",
    });
  });

  it("dispatches correct selection payload when switching to a Named Agent", () => {
    const onSelect = vi.fn();
    render(
      <ChatProviderSelect
        activeConversation={createConversation({ namedAgentId: null, provider: "openai-compatible" })}
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByTestId("chat-agent-select"), {
      target: { value: "agent-3" },
    });

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: "agent-3",
      provider: "oh-my-pi",
    });
  });
  it("dispatches correct selection payload when switching to a CLI Provider", () => {
    const onSelect = vi.fn();
    render(
      <ChatProviderSelect
        activeConversation={createConversation({ namedAgentId: "agent-1", provider: "claude-code" })}
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByTestId("chat-agent-select"), {
      target: { value: "oh-my-pi" },
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "oh-my-pi",
    });
  });

  it("disables the single selector when conversation has messages or is busy", () => {
    const { rerender } = render(
      <ChatWorkspaceHeader
        activeConversation={createConversation()}
        activeProvider="claude-code"
        hasMessages={true}
        isBusy={false}
        onSelectAgentOrProvider={noop}
      />,
    );

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
