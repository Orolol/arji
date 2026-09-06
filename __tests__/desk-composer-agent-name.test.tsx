/**
 * B-arij-OZUKyqpxmKaT — the desk composer's field under a long agent name.
 *
 * THE DEFECT, measured in Chrome on `/` before the fix (the desk's own
 * composer, one project, the 107-character named agent below chosen through
 * the real dropdown):
 *
 *   viewport   band    project pill   agent pill   field
 *     390       362        76.7          739.6       0
 *     640       612        76.7          739.6       0
 *     768       740        76.7          739.6       0
 *    1024       996        76.7          739.6      88.8
 *    1280      1252        76.7          739.6     344.8
 *    1440      1412        76.7          739.6     504.8
 *
 * `SelectPill` is `shrink-0`, so the pill took its max-content width and the
 * only item that could yield was the field — which went to ZERO at the three
 * narrow widths and stayed under the 160px `e2e/chat-mobile-layout.spec.ts`
 * calls a usable field at 1024. The pill also overflowed the band by 527px at
 * 390 (right edge 903px against the band's 376px) and was painted over the
 * desk's edge. `document.scrollWidth` equalled `clientWidth` at every width:
 * the page never scrolled sideways, so a `scrollWidth`-only assertion sees
 * none of this.
 *
 * jsdom has no layout engine and does not load Tailwind, so it can measure
 * neither the field nor the overflow. What it CAN pin is the mechanism: a cap
 * that survives every width, a pill that yields instead of pushing, and a row
 * whose shape is decided by the composer's own width. The pixels are in
 * `e2e/desk-composer-agent-name.spec.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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

import { DeskComposer } from "@/components/desk/DeskComposer";
import type { DeskProject } from "@/lib/control-desk/types";

/**
 * The band width from which the composer's row fits a field AND its pills —
 * of the BAND, not of the window. Kept in step with
 * `components/shared/AgentSelectPill.tsx`, which owns the literal classes.
 */
const COMPOSER_ONE_ROW = "36rem";

/**
 * The agent label B-arij-180 measured with, character for character.
 * `createNamedAgentSchema` (lib/validation/schemas.ts:193) puts NO length
 * bound on `name` — it only refuses a blank one — so this is an ordinary value
 * the API accepts.
 */
const LONG_AGENT_NAME =
  "Claude Code — Architecture, implementation et revue des interfaces du projet Arij — raisonnement approfondi";

const PROJECT: DeskProject = {
  id: "p1",
  name: "Piscine",
  shortName: "PISC",
  colorIndex: 0,
  activeAgents: 0,
  autoModeEnabled: false,
};

/** The class list of an element, as tokens rather than as one string. */
function classTokens(element: Element | null): string[] {
  return (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function renderComposer(agentName = LONG_AGENT_NAME) {
  namedAgents.current = [
    { id: "long-agent", name: agentName, provider: "claude-code" },
  ];
  render(
    <DeskComposer
      projects={[PROJECT]}
      targetProjectId="p1"
      onTargetProjectChange={vi.fn()}
      namedAgentId="long-agent"
      onNamedAgentChange={vi.fn()}
      onSubmit={vi.fn()}
    />,
  );
}

/** The agent pill — `ink` toned, as against the project pill's `project`. */
function agentPill(): Element {
  const pill = screen
    .getByTestId("desk-composer")
    .querySelector('[data-slot="select-pill"][data-tone="ink"]');
  expect(pill, "the composer has no agent pill").not.toBeNull();
  return pill!;
}

function band(): Element {
  const element = screen
    .getByTestId("desk-composer")
    .querySelector('[data-slot="strata-band"]');
  expect(element, "the composer has no band").not.toBeNull();
  return element!;
}

beforeEach(() => {
  namedAgents.current = [];
  namedAgents.loading = false;
});

afterEach(() => {
  namedAgents.current = [];
});

describe("desk composer — the row a long agent name has to share", () => {
  it("caps the agent pill at every width", () => {
    renderComposer();
    const tokens = classTokens(agentPill());

    // Two caps, one per row shape: 45% of the band while it is wrapped (the
    // pill shares that row with the project pill and nothing else), 30% of the
    // composer once it shares a row with the field. `cqw` rather than `%`
    // because the threshold that justifies it is expressed on the container.
    expect(tokens).toContain("max-w-[45%]");
    expect(tokens).toContain(`@min-[${COMPOSER_ONE_ROW}]:max-w-[30cqw]`);
    for (const token of tokens) {
      expect(token, `${token} lifts the agent pill's cap`).not.toMatch(
        /^(\S+:)?max-w-none$/,
      );
    }
  });

  it("lets the agent pill yield rather than push the field to zero", () => {
    renderComposer();
    const tokens = classTokens(agentPill());

    // `SelectPill` is `shrink-0` by default, which is right for a pill whose
    // label is a project's short name and wrong for one holding an arbitrary
    // agent name: it made the pill the one item that could not give way, so
    // the field gave way instead. `min-w-0` is what lets the label's own
    // `truncate` engage below its content width.
    expect(tokens).toContain("shrink");
    expect(tokens, "the agent pill still refuses to shrink").not.toContain(
      "shrink-0",
    );
    expect(tokens).toContain("min-w-0");
  });

  it("hands the field its own row by the composer's width, not the window's", () => {
    renderComposer();

    // The container is what makes `@min-[…]` mean anything at all: without it
    // the variant never matches and the band is stuck wrapped. It also has to
    // be the composer's own box — `/projects/:id` mounts this desk beside a
    // resizable chat panel, so the band is far narrower than the window there
    // and a viewport breakpoint reads the wrong number.
    expect(classTokens(screen.getByTestId("desk-composer"))).toContain(
      "@container",
    );

    const bandTokens = classTokens(band());
    expect(bandTokens).toContain("flex-wrap");
    expect(bandTokens).toContain(`@min-[${COMPOSER_ONE_ROW}]:flex-nowrap`);
    // A row that cannot grow a second line cannot give the field one.
    expect(bandTokens).toContain("min-h-[58px]");
    expect(
      bandTokens,
      "the band is still pinned to one 58px row",
    ).not.toContain("h-[58px]");
    expect(
      bandTokens,
      "the band still takes its row from a viewport breakpoint",
    ).not.toContain("sm:flex-nowrap");

    const fieldTokens = classTokens(screen.getByTestId("desk-composer-input"));
    // 29px is the glyph (16) plus the band's gap (13): the field takes the
    // whole first row minus what sits before it.
    expect(fieldTokens).toContain("basis-[calc(100%-29px)]");
    expect(fieldTokens).toContain(`@min-[${COMPOSER_ONE_ROW}]:basis-0`);
    expect(fieldTokens).toContain("min-w-0");
    expect(
      fieldTokens,
      "the field still takes its row from a viewport breakpoint",
    ).not.toContain("sm:basis-0");
  });

  it("keeps the whole name in the accessibility tree while the pill truncates", () => {
    renderComposer();

    // Truncation is CSS. A fix that shortened the string instead would take
    // the value out of the DOM with it, and the pill would stop naming the
    // agent it dispatches to.
    expect(agentPill()).toHaveTextContent(LONG_AGENT_NAME);
    expect(
      agentPill().querySelector("span")?.getAttribute("class") ?? "",
    ).toContain("truncate");
  });
});
