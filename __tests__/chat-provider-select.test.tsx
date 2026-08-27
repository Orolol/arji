import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// Native-select stand-in for the shadcn Select (Radix popper is not
// drivable from jsdom). SelectItem -> <option>, trigger/value render nothing.
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
      data-testid="provider-select-native"
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

import { ChatProviderSelect } from "@/components/chat/ChatProviderSelect";
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

function optionValues(): string[] {
  const select = screen.getByTestId("provider-select-native") as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.value);
}

describe("ChatProviderSelect", () => {
  beforeEach(() => {
    mockAgents = [
      { id: "agent-1", name: "Claude Code", provider: "claude-code", model: "sonnet" },
      { id: "agent-2", name: "Codex", provider: "codex", model: "gpt-5.3" },
    ];
  });

  it("offers Direct API (OpenAI-compatible) plus all configured Named Agents", () => {
    render(
      <ChatProviderSelect activeConversation={conversation()} onSelect={noop} />,
    );

    const values = optionValues();
    expect(values).toContain("openai-compatible");
    expect(values).toContain("agent-1");
    expect(values).toContain("agent-2");
    expect(values).toContain("claude-code-persistent");
  });

  it("labels the fast mode OpenAI-compatible", () => {
    render(
      <ChatProviderSelect
        activeConversation={conversation({ provider: "openai-compatible" })}
        onSelect={noop}
      />,
    );

    const select = screen.getByTestId("provider-select-native") as HTMLSelectElement;
    const fastOption = Array.from(select.options).find(
      (o) => o.value === "openai-compatible",
    );
    expect(fastOption?.textContent).toBe("OpenAI-compatible");
  });

  it("falls back to the stored provider when the linked named agent was deleted", () => {
    render(
      <ChatProviderSelect
        activeConversation={conversation({ namedAgentId: "agent-gone", provider: "codex" })}
        onSelect={noop}
      />,
    );

    const select = screen.getByTestId("provider-select-native") as HTMLSelectElement;
    expect(select.value).toBe("codex");
  });

  it("reports the chosen provider and named agent through onSelect", () => {
    const onSelect = vi.fn();
    render(
      <ChatProviderSelect activeConversation={conversation()} onSelect={onSelect} />,
    );

    fireEvent.change(screen.getByTestId("provider-select-native"), {
      target: { value: "openai-compatible" },
    });

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "openai-compatible",
    });

    fireEvent.change(screen.getByTestId("provider-select-native"), {
      target: { value: "agent-2" },
    });

    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: "agent-2",
      provider: "codex",
    });

    fireEvent.change(screen.getByTestId("provider-select-native"), {
      target: { value: "claude-code-persistent" },
    });
    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "claude-code-persistent",
    });

    fireEvent.change(screen.getByTestId("provider-select-native"), {
      target: { value: "oh-my-pi-persistent" },
    });
    expect(onSelect).toHaveBeenCalledWith({
      namedAgentId: null,
      provider: "oh-my-pi-persistent",
    });
  });
});

describe("ChatWorkspaceHeader provider select gating", () => {
  function renderHeader(props: Partial<Parameters<typeof ChatWorkspaceHeader>[0]> = {}) {
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

  it("enables the unified select for a fresh chat conversation", () => {
    renderHeader();
    const select = screen.getByTestId("provider-select-native") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    expect(optionValues()).toContain("openai-compatible");
    expect(optionValues()).toContain("agent-1");
  });

  it("disables the select once the conversation has messages", () => {
    renderHeader({ hasMessages: true });
    expect(screen.getByTestId("provider-select-native")).toBeDisabled();
  });

  it("disables the select while busy", () => {
    renderHeader({ isBusy: true });
    expect(screen.getByTestId("provider-select-native")).toBeDisabled();
  });

  it("disables the select when no conversation is active", () => {
    renderHeader({ activeConversation: null });
    expect(screen.getByTestId("provider-select-native")).toBeDisabled();
  });

  it("keeps the select enabled for a fresh conversation even when a named agent is selected", () => {
    renderHeader({
      activeConversation: conversation({ namedAgentId: "agent-1" }),
    });
    const select = screen.getByTestId("provider-select-native") as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    expect(select.value).toBe("agent-1");
  });

  it("renders a single select dropdown without a second disabled dropdown", () => {
    renderHeader();
    const selects = screen.getAllByTestId("provider-select-native");
    expect(selects).toHaveLength(1);
  });

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
