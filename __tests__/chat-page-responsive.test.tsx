/**
 * B-arij-180 — the chat page on a phone.
 *
 * THE DEFECT, as audited at 390x844: `ChatPageView` laid its three columns out
 * horizontally with two of them pinned at `w-[300px] shrink-0` and no
 * breakpoint anywhere. 300 + 300 + the gaps and page padding already exceed a
 * 390px viewport before the thread asks for a single pixel, so the roster ate
 * the screen, the thread and the composer were pushed off it, and the context
 * rail hung past the right edge.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. jsdom has no layout engine: it cannot
 * tell you that a box overflows, that two boxes overlap, or that the page
 * scrolls sideways. So this file pins the MECHANISM — the pane state, which
 * pane is mounted-but-hidden, the switcher that reaches the other two, the
 * focus hand-off — and the class tokens that caused the defect (an
 * unconditional 300px column). The pixels are `e2e/chat-mobile-layout.spec.ts`,
 * which measures the real thing in Chrome at 390, 768, 1280 and 1440.
 *
 * The composer's own row is here for the same reason: giving the page back to
 * the thread left the field 24px wide between three fixed controls (measured),
 * so the band wraps below `sm`. This file pins that it wraps; the e2e file is
 * what proves the field ends up 297px rather than 24px.
 */

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ChatMessage } from "@/hooks/useChat";
import type { Conversation } from "@/hooks/useConversations";
import type { ControlDeskPayload, DeskProject } from "@/lib/control-desk/types";

const PROJECT: DeskProject = {
  id: "p1",
  name: "Arij",
  shortName: "ARIJ",
  colorIndex: 0,
  activeAgents: 0,
  autoModeEnabled: false,
};

const CONVERSATIONS: Conversation[] = [
  {
    id: "conv-1",
    projectId: "p1",
    type: "brainstorm",
    label: "Brainstorm du matin",
    status: "active",
    epicId: null,
    provider: "claude-code",
    createdAt: "2026-09-01T08:00:00.000Z",
  },
  {
    id: "conv-2",
    projectId: "p1",
    type: "brainstorm",
    label: "Refonte mobile",
    status: "active",
    epicId: null,
    provider: "claude-code",
    createdAt: "2026-09-02T08:00:00.000Z",
  },
];

const MESSAGES: ChatMessage[] = [
  {
    id: "m1",
    projectId: "p1",
    role: "user",
    content: "Le fil tient-il sur un téléphone ?",
    createdAt: "2026-09-02T08:01:00.000Z",
  },
  {
    id: "m2",
    projectId: "p1",
    role: "assistant",
    content: "Voici la réponse de l'agent.",
    createdAt: "2026-09-02T08:02:00.000Z",
  },
];

const DESK: ControlDeskPayload = {
  generatedAt: "2026-09-05T10:00:00.000Z",
  projects: [PROJECT],
  working: [],
  queued: [],
  today: {
    merged: 0,
    released: 0,
    failed: 0,
    reviewed: 0,
  } as unknown as ControlDeskPayload["today"],
  yourTurn: { awaitingReply: [], failed: [], conflicts: [] },
  readyToLand: [],
  heldBackCount: 0,
  upNext: [],
};

const setActiveId = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/useControlDesk", () => ({
  useControlDesk: () => ({
    data: DESK,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: CONVERSATIONS,
    activeId: "conv-1",
    setActiveId,
    loading: false,
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    restartPersistentSession: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useChat", () => ({
  useChat: () => ({
    messages: MESSAGES,
    setMessages: vi.fn(),
    loading: false,
    sending: false,
    error: null,
    pendingQuestions: null,
    streamStatus: null,
    sendMessage: vi.fn(),
    answerQuestions: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

vi.mock("@/hooks/useSpecGeneration", () => ({
  useSpecGeneration: () => ({
    generateSpec: vi.fn(),
    generating: false,
    error: null,
  }),
}));

vi.mock("@/hooks/useEpicCreate", () => ({
  useEpicCreate: () => ({
    createEpic: vi.fn(),
    isLoading: false,
    error: null,
    createdEpic: null,
  }),
}));

vi.mock("@/hooks/usePolling", () => ({ usePolling: () => {} }));

const { ChatPageView } = await import("@/components/chat-page/ChatPageView");

/**
 * jsdom ships no ResizeObserver and the roster's Radix ScrollArea constructs
 * one. Same shim as `__tests__/chat-page-thread.test.tsx`.
 */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver ??=
    NoopResizeObserver as unknown as typeof ResizeObserver;
  vi.clearAllMocks();
  window.localStorage.clear();
  // Everything the page reads on mount — spec, memory, documents — answers
  // "nothing here". None of it is what this file is about.
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: [] }),
  }) as unknown as typeof fetch;
});

async function renderChat() {
  await act(async () => {
    render(<ChatPageView initialProjectId="p1" />);
  });
}

/** The class list of an element, as tokens rather than as one string. */
function classTokens(element: Element | null): string[] {
  return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** A pane is "showing" when nothing in its class list turns it off. */
function isShowing(element: Element | null): boolean {
  return !classTokens(element).includes("hidden");
}

describe("chat page — the three panes on a narrow viewport", () => {
  it("hands the phone a pane switcher that reaches all three panes", async () => {
    await renderChat();

    const switcher = screen.getByTestId("chat-pane-switcher");
    // Below `lg` only: the desktop frame draws all three columns at once and
    // must not gain a second control row (see ChatPageView's header comment).
    expect(classTokens(switcher)).toContain("lg:hidden");

    for (const label of ["Conversations", "Fil", "Contexte"]) {
      expect(
        screen.getByRole("button", { name: label }),
      ).toBeInTheDocument();
    }
  });

  it("shows the thread and the composer first, with the flanks off", async () => {
    await renderChat();

    expect(isShowing(screen.getByTestId("chat-thread-pane"))).toBe(true);
    expect(screen.getByTestId("chat-thread")).toBeInTheDocument();
    expect(screen.getByTestId("chat-composer")).toBeInTheDocument();

    // The roster and the context rail stay MOUNTED — they are `display:none`,
    // not removed — so `lg:` alone brings them back with no state to restore.
    expect(isShowing(screen.getByTestId("chat-roster"))).toBe(false);
    expect(isShowing(screen.getByTestId("chat-context"))).toBe(false);
  });

  it("never pins a flank at 300px without a breakpoint to escape it", async () => {
    await renderChat();

    // THE DEFECT, in one assertion. `w-[300px]` with no qualifier is what put
    // 600px of columns into a 390px viewport; the fix is a full-width pane
    // that only becomes a 300px column once there is room for three.
    for (const testId of ["chat-roster", "chat-context"]) {
      const tokens = classTokens(screen.getByTestId(testId));
      expect(tokens, `${testId} still pins an unconditional 300px`).not.toContain(
        "w-[300px]",
      );
      expect(tokens, `${testId} lost its desktop width`).toContain(
        "lg:w-[300px]",
      );
    }
  });

  it("gives the composer field its own row instead of squeezing it", async () => {
    await renderChat();

    const band = screen
      .getByTestId("chat-composer")
      .querySelector('[data-slot="strata-band"]');
    const tokens = classTokens(band);

    // Below `sm` the glyph + field + three controls do not share 326px: the
    // field measured 24px. Above it, `sm:flex-nowrap` restores the one-line
    // band the frame draws.
    expect(tokens).toContain("flex-wrap");
    expect(tokens).toContain("sm:flex-nowrap");
  });

  it("keeps a VISIBLE focus ring on the switcher's segments", async () => {
    await renderChat();

    // Measured in Chrome before `SegmentedControl` gained this class: the
    // segment matched `:focus-visible` with `outline-width: 2px` and the right
    // colour, and painted nothing — Tailwind v4's `outline-none` sets
    // `--tw-outline-style: none`, and `outline-2` resolves its style from that
    // variable. jsdom cannot see the ring, so this pins the token that draws
    // it; `e2e/chat-mobile-layout.spec.ts` is where the keyboard path runs.
    for (const label of ["Conversations", "Fil", "Contexte"]) {
      expect(
        classTokens(screen.getByRole("button", { name: label })),
        `the ${label} segment has no focus-visible outline style`,
      ).toContain("focus-visible:outline-solid");
    }
  });

  it("swaps which pane is showing when the switcher is used", async () => {
    const user = userEvent.setup();
    await renderChat();

    await user.click(screen.getByRole("button", { name: "Conversations" }));
    expect(isShowing(screen.getByTestId("chat-roster"))).toBe(true);
    expect(isShowing(screen.getByTestId("chat-thread-pane"))).toBe(false);
    expect(isShowing(screen.getByTestId("chat-context"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Contexte" }));
    expect(isShowing(screen.getByTestId("chat-context"))).toBe(true);
    expect(isShowing(screen.getByTestId("chat-roster"))).toBe(false);
    expect(isShowing(screen.getByTestId("chat-thread-pane"))).toBe(false);

    await user.click(screen.getByRole("button", { name: "Fil" }));
    expect(isShowing(screen.getByTestId("chat-thread-pane"))).toBe(true);
  });

  it("returns to the thread — and moves focus there — after picking a conversation", async () => {
    const user = userEvent.setup();
    await renderChat();

    await user.click(screen.getByRole("button", { name: "Conversations" }));

    const cards = screen.getAllByTestId("chat-roster-card");
    const other = cards.find((card) =>
      card.textContent?.includes("Refonte mobile"),
    );
    expect(other).toBeTruthy();
    await user.click(other!);

    expect(setActiveId).toHaveBeenCalledWith("conv-2");
    // Without this the pane you tapped is the pane that disappears, and the
    // conversation you just chose is on a screen you are no longer looking at.
    const pane = screen.getByTestId("chat-thread-pane");
    expect(isShowing(pane)).toBe(true);
    // The tapped card is gone with its pane, so focus would land on <body>.
    await waitFor(() => expect(document.activeElement).toBe(pane));
  });
});
