/**
 * The named-agent editor's "CLI options" section and persona field.
 *
 * The section is rendered from lib/providers/options-registry.ts, so the
 * assertions here derive their expectations from the registry rather than
 * restating them — a hard-coded option list in the frontend is exactly what
 * this design forbids, and a test that repeated the list would hide it.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

type StoredAgent = {
  id: string;
  name: string;
  provider: string;
  model: string;
  options: Record<string, unknown>;
  personaPrompt: string | null;
  escalatesTo: string | null;
  createdAt: string | null;
};

const agents: StoredAgent[] = [];
const putBodies: Array<Record<string, unknown>> = [];

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : {};

    if (url === "/api/agent-config/named-agents" && method === "GET") {
      return jsonResponse({ data: agents.map((agent) => ({ ...agent })) });
    }
    if (url === "/api/providers/available") {
      return jsonResponse({
        data: { "claude-code": true, codex: true, "oh-my-pi": true, agy: true },
      });
    }
    if (url.startsWith("/api/agent-config/named-agents/") && method === "PUT") {
      putBodies.push(body);
      const id = url.split("/").pop() as string;
      const agent = agents.find((candidate) => candidate.id === id);
      if (agent) Object.assign(agent, body);
      return jsonResponse({ data: agent });
    }
    throw new Error(`unexpected endpoint: ${method} ${url}`);
  }),
);

// Radix popper is not drivable from jsdom — same stand-in as the other
// agent-config component tests. Select-backed options are covered by the
// registry unit tests; the fields exercised here are the text/number ones.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value }: { children?: ReactNode; value?: string }) => (
    <div data-select-value={value}>{children}</div>
  ),
  SelectTrigger: ({ id }: { id?: string }) => <select id={id} />,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <div data-value={value}>{children}</div>
  ),
}));

import { NamedAgentsTab } from "@/components/agent-config/NamedAgentsTab";
import {
  resetOptionsForProvider,
  CliOptionsFields,
} from "@/components/agent-config/CliOptionsFields";
import { getProviderOptionDefinitions } from "@/lib/providers/options-registry";
import { DEFAULT_PERSONA_PROMPT } from "@/lib/agent-config/constants";

function seedAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  const agent: StoredAgent = {
    id: "na-1",
    name: "Builder",
    provider: "oh-my-pi",
    model: "",
    options: {},
    personaPrompt: DEFAULT_PERSONA_PROMPT,
    escalatesTo: null,
    createdAt: null,
    ...overrides,
  };
  agents.push(agent);
  return agent;
}

beforeEach(() => {
  agents.length = 0;
  putBodies.length = 0;
});

describe("CLI options section", () => {
  it("renders exactly the options the registry declares for the agent's CLI", async () => {
    seedAgent({ provider: "oh-my-pi" });
    render(<NamedAgentsTab />);

    await screen.findByDisplayValue("Builder");
    for (const definition of getProviderOptionDefinitions("oh-my-pi")) {
      expect(screen.getByLabelText(definition.label)).toBeTruthy();
    }
    // Nothing from another CLI leaks in.
    for (const definition of getProviderOptionDefinitions("codex")) {
      expect(screen.queryByLabelText(definition.label)).toBeNull();
    }
  });

  it("renders no section at all for a CLI with no registry entry", () => {
    const { container } = render(
      <CliOptionsFields
        idPrefix="test"
        provider="not-a-cli"
        options={{}}
        onChange={() => {}}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("saves an edited option value", async () => {
    seedAgent({ provider: "oh-my-pi" });
    render(<NamedAgentsTab />);

    await screen.findByDisplayValue("Builder");
    fireEvent.change(screen.getByLabelText("Time limit (seconds)"), {
      target: { value: "600" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].options).toEqual({ max_time: 600 });
  });

  it("clears an option back to the CLI default", async () => {
    seedAgent({ provider: "oh-my-pi", options: { max_time: 600 } });
    render(<NamedAgentsTab />);

    await screen.findByDisplayValue("Builder");
    fireEvent.change(screen.getByLabelText("Time limit (seconds)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].options).toEqual({});
  });
});

describe("resetOptionsForProvider", () => {
  it("drops keys the target CLI does not declare", () => {
    expect(
      resetOptionsForProvider("oh-my-pi", {
        reasoning_effort: "high",
        thinking: "low",
      }),
    ).toEqual({ thinking: "low" });
  });

  it("drops a value the target CLI declares but does not accept", () => {
    // Both claude and agy have `effort`; only claude goes up to `max`.
    expect(resetOptionsForProvider("agy", { effort: "max" })).toEqual({});
    expect(resetOptionsForProvider("agy", { effort: "high" })).toEqual({
      effort: "high",
    });
  });

  it("drops everything for a CLI with no options", () => {
    expect(resetOptionsForProvider("zai", { thinking: "low" })).toEqual({});
  });
});

describe("persona field", () => {
  it("shows the stored persona and saves an edit", async () => {
    seedAgent({ personaPrompt: "You're an experienced developer" });
    render(<NamedAgentsTab />);

    const field = (await screen.findByLabelText(
      "Persona",
    )) as HTMLTextAreaElement;
    expect(field.value).toBe("You're an experienced developer");

    fireEvent.change(field, { target: { value: "You are a security expert" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].personaPrompt).toBe("You are a security expert");
  });

  it("can be emptied, which means nothing is injected", async () => {
    seedAgent({ personaPrompt: "Something" });
    render(<NamedAgentsTab />);

    const field = await screen.findByLabelText("Persona");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0].personaPrompt).toBe("");
  });

  it("shows an agent with no persona as empty, with the default as guidance", async () => {
    // Agents that predate the feature keep a NULL persona: nothing is
    // injected into their prompts until someone sets one.
    seedAgent({ personaPrompt: null });
    render(<NamedAgentsTab />);

    const field = (await screen.findByLabelText(
      "Persona",
    )) as HTMLTextAreaElement;
    expect(field.value).toBe("");
    expect(field.placeholder).toBe(DEFAULT_PERSONA_PROMPT);
  });
});
