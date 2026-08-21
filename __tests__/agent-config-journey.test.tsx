/**
 * Journey test — "a brand-new user creates a build agent and a review agent
 * from zero, with no documentation and without getting blocked."
 *
 * Drives the real NamedAgentsTab and ReviewAgentsTab components against an
 * in-memory fetch stub backing the same endpoints the hooks call. The point
 * is the flow: every field already carries a usable default or explicit
 * placeholder, so nothing on either path requires outside knowledge.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

type NamedAgent = { id: string; name: string; provider: string; model: string };
type ReviewAgent = {
  id: string;
  name: string;
  systemPrompt: string;
  scope: string;
  position: number;
  isEnabled: number;
  createdAt: string | null;
  updatedAt: string | null;
};

const namedAgents: NamedAgent[] = [];
const reviewAgents: ReviewAgent[] = [];
let idCounter = 0;

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as Response;
}

/**
 * Minimal backend for exactly the endpoints the journey touches. Anything
 * else fails loudly — a silent wrong route would fake a passing journey.
 */
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : {};

    if (url === "/api/agent-config/named-agents" && method === "GET") {
      return jsonResponse({ data: [...namedAgents] });
    }
    if (url === "/api/agent-config/named-agents" && method === "POST") {
      if (!body.name?.trim()) return jsonResponse({ error: "name required" }, false);
      const agent = {
        id: `na-${++idCounter}`,
        name: body.name,
        provider: body.provider,
        model: body.model ?? "",
      };
      namedAgents.push(agent);
      return jsonResponse({ data: agent });
    }
    if (url === "/api/agent-config/review-agents" && method === "GET") {
      return jsonResponse({ data: [...reviewAgents] });
    }
    if (url === "/api/agent-config/review-agents" && method === "POST") {
      if (!body.name?.trim() || !body.systemPrompt?.trim()) {
        return jsonResponse({ error: "name and systemPrompt required" }, false);
      }
      const agent = {
        id: `ra-${++idCounter}`,
        name: body.name,
        systemPrompt: body.systemPrompt,
        scope: "global",
        position: reviewAgents.length,
        isEnabled: 1,
        createdAt: null,
        updatedAt: null,
        source: "global",
      };
      reviewAgents.push(agent);
      return jsonResponse({ data: agent });
    }
    throw new Error(`journey test hit unexpected endpoint: ${method} ${url}`);
  }),
);

// Radix popper is not drivable from jsdom — same stand-in as the
// disclosure test. The journey keeps the CLI at its default anyway.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectTrigger: ({ id }: { id?: string }) => <select id={id} disabled />,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => <option value={value}>{children}</option>,
}));

import { NamedAgentsTab } from "@/components/agent-config/NamedAgentsTab";
import { ReviewAgentsTab } from "@/components/agent-config/ReviewAgentsTab";

beforeEach(() => {
  namedAgents.length = 0;
  reviewAgents.length = 0;
});

describe("new-user journey: create agents without documentation", () => {
  it("creates a build agent from just a name, CLI defaulted", async () => {
    render(<NamedAgentsTab />);

    // The form explains itself: labels + hints, no doc needed.
    expect(await screen.findByLabelText("Name")).toBeTruthy();
    expect(
      screen.getByText(/The coding tool this agent runs on/)
    ).toBeTruthy();

    // One typed field is the whole build-agent flow.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Builder" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add agent/i }));

    await waitFor(() => {
      expect(namedAgents.map((a) => a.name)).toEqual(["Builder"]);
    });
    // The untouched fields carried valid defaults.
    expect(namedAgents[0].provider).toBe("claude-code");
    expect(namedAgents[0].model).toBe("");

    // The created agent shows up in the list, ready to use.
    await screen.findByDisplayValue("Builder");
  });

  it("creates a review agent without writing a prompt — default prefilled", async () => {
    render(<ReviewAgentsTab scope="global" />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Add Review Agent/i })
    );

    // The instructions field arrives pre-filled: a new user who writes only
    // a name can still create a working reviewer.
    const promptField = screen.getByLabelText(
      "Instructions"
    ) as HTMLTextAreaElement;
    expect(promptField.value.trim().length).toBeGreaterThan(0);
    expect(promptField.value).toMatch(/code reviewer/i);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Security pass" },
    });

    const createButton = screen.getByRole("button", {
      name: /Create/i,
    }) as HTMLButtonElement;
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(reviewAgents.map((a) => a.name)).toEqual(["Security pass"]);
    });
    expect(reviewAgents[0].systemPrompt).toBe(promptField.value);
  });
});
