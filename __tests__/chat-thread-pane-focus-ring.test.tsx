/**
 * B-arij-231 — the chat thread pane cleared its outline and offered nothing.
 *
 * THE DEFECT, and why it was red on `main` rather than on anybody's branch.
 * `THREAD_PANE_CLASS` (components/chat-page/ChatPageView.tsx) carried
 * `outline-none` and no focus affordance at all, on both of its mounts — the
 * real workspace pane the phone hands focus to, and the empty state's. It
 * arrived while the scan that finds that shape was itself in flight on another
 * branch, so nothing conflicted in git and only a RUN showed it:
 * `__tests__/focus-ring-undeclared.test.tsx` listed both sites.
 *
 * THE CHOICE THIS FILE PINS. That rule offers two exits — give the element a
 * ring, or record a documented `NO_AFFORDANCE_NEEDED` exemption — and the
 * ticket is right that picking between them is a judgement about the pane, not
 * a formality. Measured in real Chrome (channel `chrome`, scratch stack on a
 * spare port, one project, two seeded conversations, 2026-09-06):
 *
 *   PHONE 390x844, tab to a roster card and press Enter (or Space)
 *     activeElement             chat-thread-pane
 *     matches(":focus-visible") TRUE
 *     outline-style             none        <- nothing painted
 *
 *   PHONE 390x844, TAP the same card
 *     activeElement             chat-thread-pane
 *     matches(":focus-visible") false       <- a focus-visible ring stays off
 *
 *   Tab order, 30 presses at 390 and 40 at 1440: the pane is NEVER reached.
 *   The pane is not a scroll container either — `overflow: visible`,
 *   `scrollHeight === clientHeight` (the transcript scrolls in a Radix
 *   viewport further down), so no browser tabs to it as a scrollable region.
 *
 * So the exemption's premise — "focused programmatically, never in the Tab
 * order, no keyboard affordance to lose", which is true of `TicketOverlay` —
 * is FALSE here. The pane is the destination of a KEYBOARD hand-off: a
 * keyboard user presses Enter on a conversation card, the card's pane is
 * destroyed, focus is moved here, `:focus-visible` matches, and with
 * `outline-none` alone the user is given no indication of where focus went.
 * The overlay is a modal that traps focus and repaints the screen; this pane
 * replaces one column in place. Hence the ring.
 *
 * WHAT THIS FILE PROVES, and what it does not. It resolves the pane's class
 * list with the real Tailwind engine (`./helpers/tailwind-outline`) off the
 * RENDERED DOM, so it fails both when the ring goes and when `outline-none`
 * comes back without one. jsdom loads no CSS, so that Chrome draws the ring is
 * a visual claim, measured in `e2e/chat-thread-pane-focus.spec.ts`.
 *
 * AND IT PINS THE SCANNER TOO. The gap can reopen from either side: the class
 * can lose its ring, or the scan can stop SEEING the class — a lost site makes
 * `focus-ring-undeclared.test.tsx` pass for the wrong reason, silently, which
 * is the exact failure that put this ticket in the backlog four times. The last
 * describe reads the source through the same helpers the rule uses and asserts
 * both mounts are still visible to them.
 */

import { readFileSync } from "node:fs";

import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import type { ChatMessage } from "@/hooks/useChat";
import type { Conversation } from "@/hooks/useConversations";
import type { ControlDeskPayload, DeskProject } from "@/lib/control-desk/types";

import {
  describeSite,
  elementClassLists,
  undeclaredFocusSites,
} from "./helpers/class-list-scan";
import {
  classTokens,
  resolveFocusVisibleOutline,
} from "./helpers/tailwind-outline";

const CHAT_PAGE_VIEW = "components/chat-page/ChatPageView.tsx";

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
];

const MESSAGES: ChatMessage[] = [
  {
    id: "m1",
    projectId: "p1",
    role: "user",
    content: "Le fil tient-il sur un téléphone ?",
    createdAt: "2026-09-02T08:01:00.000Z",
  },
];

/**
 * The desk read the page scopes itself with. Swapped to `null` for the empty
 * state: `ChatPageView` renders `EmptyChatWorkspace` — the pane's SECOND mount
 * — whenever it resolves no project, which is every first paint of `/chat`
 * before the desk answers, not a hypothetical.
 */
const desk = vi.hoisted(() => ({
  current: null as ControlDeskPayload | null,
}));

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/hooks/useControlDesk", () => ({
  useControlDesk: () => ({
    data: desk.current,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useConversations", () => ({
  useConversations: () => ({
    conversations: CONVERSATIONS,
    activeId: "conv-1",
    setActiveId: vi.fn(),
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

/** jsdom ships no ResizeObserver; the roster's Radix ScrollArea constructs one. */
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
  desk.current = DESK;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: [] }),
  }) as unknown as typeof fetch;
});

async function renderChat(initialProjectId?: string) {
  await act(async () => {
    render(<ChatPageView initialProjectId={initialProjectId} />);
  });
}

/**
 * Resolve the pane's class list for `:focus-visible` and assert a ring is
 * actually drawn.
 *
 * The RESOLVED value, never the class name: the sibling regression
 * (B-arij-JJ5FdaHpX7d6) shipped `focus-visible:outline-2` on every control of
 * the TopBar and painted nothing, because `outline-none` sets
 * `--tw-outline-style: none` and `outline-2` reads its style back out of that
 * variable. `expect(className).toContain(…)` passes on that bug.
 */
async function expectPaintedRing(element: Element, where: string) {
  const resolved = await resolveFocusVisibleOutline(
    classTokens(element.className),
  );

  expect(
    resolved.paints,
    `${where} resolves outline-style: ${resolved.style} under :focus-visible, ` +
      `so a keyboard user is handed focus with nothing to see. Class list: ` +
      `${element.className}`,
  ).toBe(true);
  expect(resolved.width, `${where} outline-width`).toBe("2px");
  // Not asserted: the colour. `outline-ring` resolves through `--color-ring`,
  // which lives in app/globals.css, while the helper compiles against the bare
  // `@import "tailwindcss"` theme — so it is undefined here for every control
  // in the app. The painted colour is read in Chrome by the e2e spec.
}

describe("the chat thread pane — the element the phone hands focus to", () => {
  it("is a programmatic focus target, not a tab stop", async () => {
    await renderChat("p1");

    const pane = screen.getByTestId("chat-thread-pane");

    // The premise of the whole judgement, kept next to it: this is the element
    // `handleSelectConversation` focuses when the roster pane closes. If the
    // hand-off ever goes, so does the reason for the ring — and this fails
    // first, pointing at the decision rather than at a stray class.
    expect(pane.tabIndex, "the pane stopped being focusable").toBe(-1);
    expect(
      pane.getAttribute("aria-label"),
      "the pane focus lands on has no accessible name",
    ).toBe("Conversation thread");
  });

  it("paints a keyboard focus ring", async () => {
    await renderChat("p1");

    await expectPaintedRing(
      screen.getByTestId("chat-thread-pane"),
      "the chat thread pane",
    );
  });

  /**
   * The pane's second mount, and the one a file-level check would miss. It is
   * the SAME constant on an element with no `tabIndex`, no ref and no
   * `aria-label` — nothing focuses it — so the ring is inert there. It is
   * asserted anyway because the constant is shared: the day someone gives the
   * empty state its own class list, this is what says the two renders of one
   * pane have drifted apart.
   */
  it("carries the same ring on the empty state's pane", async () => {
    desk.current = null;
    await renderChat();

    const pane = screen.getByTestId("chat-thread-pane");
    expect(pane.tabIndex, "the empty state's pane became focusable").toBe(-1);
    await expectPaintedRing(pane, "the empty chat workspace's thread pane");
  });
});

/**
 * The other half of the gap, and the one that reopens silently.
 *
 * `focus-ring-undeclared.test.tsx` accuses an element it can SEE. A scan that
 * loses the site — a parser hole, a class list moved behind an expression the
 * lexer stops at, a constant that stops resolving — turns that rule green
 * while the pane is exactly as bare as before. Two such holes have already
 * shipped in this scanner (a backtick in a comment, a closing tag's slash), so
 * "the rule passes" is not evidence about this pane unless the rule still
 * reaches it.
 */
describe("the rule still reaches both renders of the pane", () => {
  const source = () => readFileSync(CHAT_PAGE_VIEW, "utf8");

  /** The tokens that identify the pane, whatever line it moves to. */
  const PANE_TOKENS = ["min-h-0", "min-w-0", "flex-1", "outline-none"];

  /**
   * ELEMENT grouping, the one the rule uses — and the only one that resolves
   * `THREAD_PANE_CLASS` into the two `cn(…)` calls that mount it. Adjacent
   * grouping (the paint sweep's) sees the constant's own literal and nothing
   * at the use sites, so it would report one site here and say nothing about
   * whether either mount is still reachable by the scan.
   */
  const paneSites = () =>
    elementClassLists(source(), CHAT_PAGE_VIEW).filter((site) =>
      PANE_TOKENS.every((token) => site.classes.includes(token)),
    );

  it("resolves the pane's class list at both of its mounts", () => {
    const sites = paneSites();

    expect(
      sites.length,
      `the scan resolves ${sites.length} element class list(s) in ` +
        `${CHAT_PAGE_VIEW} carrying the thread pane's tokens, and the pane has ` +
        `two mounts (the workspace and the empty state). A scan that cannot ` +
        `see the pane cannot accuse it either, so this is a coverage loss ` +
        `however green the rule looks.`,
    ).toBeGreaterThanOrEqual(2);
  });

  it("sees a ring that paints on every one of them", async () => {
    for (const site of paneSites()) {
      const resolved = await resolveFocusVisibleOutline(site.classes);
      expect(
        resolved.paints,
        `${describeSite(site)}\n\nresolves outline-style: ${resolved.style} ` +
          `under :focus-visible — this mount of the pane draws nothing.`,
      ).toBe(true);
    }
  });

  it("accuses nothing in the file", () => {
    // The whole file, not just the pane: a new bare `outline-none` here is the
    // same defect at a different line, and this is where it should surface.
    expect(
      undeclaredFocusSites(source(), CHAT_PAGE_VIEW).map(describeSite),
    ).toEqual([]);
  });
});
