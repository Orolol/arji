import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

const agentConfig = vi.hoisted(() => ({
  createNamedAgent: vi.fn(),
  updateNamedAgent: vi.fn(),
}));

vi.mock("@/hooks/useAgentConfig", () => ({
  useNamedAgents: () => ({
    data: [
      {
        id: "agent-1",
        name: "Builder",
        provider: "claude-code",
        model: "",
        createdAt: null,
      },
    ],
    loading: false,
    createNamedAgent: agentConfig.createNamedAgent,
    updateNamedAgent: agentConfig.updateNamedAgent,
    deleteNamedAgent: vi.fn(async () => true),
  }),
}));

vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: () => ({
    providers: {
      "claude-code": true,
      codex: false,
      "gemini-cli": false,
      "mistral-vibe": false,
      "qwen-code": false,
      opencode: false,
      deepseek: false,
      kimi: false,
      zai: false,
      pi: false,
      "oh-my-pi": false,
    },
    loading: false,
  }),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectTrigger: ({ id }: { id?: string }) => <button id={id} type="button" />,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { NamedAgentsTab } from "@/components/agent-config/NamedAgentsTab";

beforeEach(() => {
  vi.clearAllMocks();
  agentConfig.createNamedAgent.mockResolvedValue({ ok: true });
  agentConfig.updateNamedAgent.mockResolvedValue({ ok: true });
});

describe("minimal named-agent form", () => {
  it("keeps creation to the two core fields with a valid CLI default", () => {
    render(<NamedAgentsTab />);

    expect(screen.getByLabelText("Name", { selector: "#new-agent-name" })).toBeTruthy();
    expect(screen.getByLabelText("CLI", { selector: "#new-agent-cli" })).toBeTruthy();
    expect(screen.queryByLabelText("Model", { selector: "#new-agent-model" })).toBeNull();

    // Scoped to the creation card: the row EDITOR below it legitimately
    // carries a persona field and a CLI-options section, and an unscoped
    // query would read those as creation fields.
    const createCard = screen
      .getByLabelText("Name", { selector: "#new-agent-name" })
      .closest("div.rounded-lg") as HTMLElement;
    expect(within(createCard).queryByText(/persona/i)).toBeNull();
    expect(within(createCard).queryByText(/CLI options/i)).toBeNull();
  });

  it("shows whether the selected CLI is usable before an agent is created", () => {
    render(<NamedAgentsTab />);

    expect(
      screen.getAllByText(/Claude Code is ready to use on this machine/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/not detected/i).length).toBeGreaterThan(0);
  });

  it("renders a create error and releases the busy state", async () => {
    agentConfig.createNamedAgent.mockResolvedValue({
      ok: false,
      error: "An agent named Claude Code already exists",
    });
    render(<NamedAgentsTab />);

    fireEvent.change(screen.getByLabelText("Name", { selector: "#new-agent-name" }), {
      target: { value: "Claude Code" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add agent/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An agent named Claude Code already exists",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add agent/i })).not.toBeDisabled(),
    );
  });

  it("renders a rename error instead of discarding it", async () => {
    agentConfig.updateNamedAgent.mockResolvedValue({
      ok: false,
      error: "An agent named Reviewer already exists",
    });
    render(<NamedAgentsTab />);

    const existingName = screen.getByLabelText("Name", {
      selector: "#named-agent-name-agent-1",
    });
    fireEvent.change(existingName, { target: { value: "Reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An agent named Reviewer already exists",
    );
  });
});
