/**
 * The redesigned /agents and /projects/:id/sessions screens at a phone
 * viewport (390 × 844, an iPhone 12/13/14 in CSS pixels).
 *
 * Both shipped with desktop-only geometry: the workshop put a fixed 330px
 * roster next to an editor whose NAME / CLI / MODEL fields carried their own
 * 280 + 200 + 220px, and the sessions screen laid four synthesis cells and
 * eight filter controls in rows that never wrapped. Measured in Chrome at
 * 390px, `document.documentElement.scrollWidth` was 425px on /agents and
 * 592px on the sessions list — the page itself scrolled sideways.
 *
 * JSDOM HAS NO LAYOUT ENGINE: nothing here can measure a rectangle, so what
 * this file pins is the cause rather than the symptom — the unconditional
 * (unprefixed, therefore mobile-facing) Tailwind geometry that made the rows
 * wider than the viewport. The rendered pixel width is verified in a real
 * browser; see e2e-free measurement notes in the epic's handoff.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

/** The narrowest viewport these screens must survive. */
const MOBILE_WIDTH = 390;
/** `px-[14px]` body gutter on both sides of the app's content area. */
const BODY_GUTTER = 14;
const MOBILE_CONTENT_WIDTH = MOBILE_WIDTH - 2 * BODY_GUTTER;

/**
 * Only UNPREFIXED utilities apply at 390px — `md:w-[330px]` is exactly the
 * shape of the fix, so a variant-prefixed class is deliberately ignored.
 */
function baseClasses(el: Element): string[] {
  return (el.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.includes(":"));
}

/** The widest unconditional `w-[Npx]` / `min-w-[Npx]` on an element. */
function fixedWidthPx(el: Element): number {
  let widest = 0;
  for (const token of baseClasses(el)) {
    const match = /^(?:min-)?w-\[(\d+(?:\.\d+)?)px\]$/.exec(token);
    if (match) widest = Math.max(widest, Number(match[1]));
  }
  return widest;
}

/** A flex row that keeps its children on one line at mobile. */
function isNonWrappingRow(el: Element): boolean {
  const base = baseClasses(el);
  return (
    base.includes("flex") &&
    !base.includes("flex-col") &&
    !base.includes("flex-wrap") &&
    !base.includes("flex-wrap-reverse")
  );
}

/** `grid-cols-5` and friends; arbitrary `grid-cols-[…fr]` tracks do shrink. */
function fixedGridColumns(el: Element): number {
  for (const token of baseClasses(el)) {
    const match = /^grid-cols-(\d+)$/.exec(token);
    if (match) return Number(match[1]);
  }
  return 0;
}

function describeElement(el: Element): string {
  const testId = el.getAttribute("data-testid");
  return `${el.tagName.toLowerCase()}${testId ? `[${testId}]` : ""}.${
    baseClasses(el).join(".") || "(no classes)"
  }`;
}

/**
 * Rows whose children cannot fit a phone: either their fixed widths add up
 * past the content width, or one child hogs more than half of it while
 * sharing the line with something else.
 */
function rowsWiderThanMobile(root: HTMLElement): string[] {
  const offenders: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!isNonWrappingRow(el)) continue;
    const children = Array.from(el.children);
    if (children.length < 2) continue;
    const widths = children.map(fixedWidthPx);
    const total = widths.reduce((sum, width) => sum + width, 0);
    const hog = Math.max(...widths);
    if (total > MOBILE_CONTENT_WIDTH || hog > MOBILE_CONTENT_WIDTH / 2) {
      offenders.push(`${describeElement(el)} — ${total}px of fixed children`);
    }
  }
  return offenders;
}

/** Column counts a phone cannot honour. */
function gridsWiderThanMobile(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("*"))
    .filter((el) => fixedGridColumns(el) > 2)
    .map((el) => `${describeElement(el)} — ${fixedGridColumns(el)} columns`);
}

/* ------------------------------------------------------------------ */
/* /agents — the workshop                                              */
/* ------------------------------------------------------------------ */

const state = vi.hoisted(() => ({
  agents: [
    {
      id: "agent-1",
      name: "Opus Builder",
      provider: "claude-code" as const,
      model: "claude-opus-5",
      options: {},
      personaPrompt: "You're an experienced developer.",
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ],
}));

vi.mock("@/hooks/useAgentConfig", () => ({
  useNamedAgents: () => ({
    data: state.agents,
    loading: false,
    refresh: vi.fn(),
    createNamedAgent: vi.fn(),
    updateNamedAgent: vi.fn(),
    deleteNamedAgent: vi.fn(),
  }),
  useAgentRosterStats: () => ({ data: {}, status: "ready", refresh: vi.fn() }),
  useNamedAgentStats: () => ({ data: null, loading: false }),
  useAgentAssignments: () => ({
    data: [],
    loading: false,
    refresh: vi.fn(),
    assignAgent: vi.fn(),
  }),
}));

vi.mock("@/hooks/useProvidersAvailable", () => ({
  useProvidersAvailable: () => ({
    providers: { "claude-code": true, codex: true, "oh-my-pi": true, agy: true },
    loading: false,
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

// Radix's popper is not drivable in jsdom; render menus inline so the fields
// that sit next to them are still measured.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children }: { children?: ReactNode }) => (
    <button type="button" role="menuitem">
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select
      aria-label="Sort sessions"
      data-testid="sessions-sort"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock("@/components/night/NightRunSummaryDialog", () => ({
  NightRunSummaryDialog: () => null,
}));

const { AgentsWorkshopView } = await import(
  "@/components/agents-workshop/AgentsWorkshopView"
);
const { default: SessionsPage } = await import(
  "@/app/projects/[projectId]/sessions/page"
);

describe("Agents workshop at a 390px viewport", () => {
  it("gives the roster the full width instead of a fixed desktop column", () => {
    const { container } = render(<AgentsWorkshopView />);

    const roster = screen.getByTestId("agent-roster");
    expect(fixedWidthPx(roster)).toBe(0);
    // …and the two columns stack rather than sharing one line.
    expect(isNonWrappingRow(roster.parentElement as HTMLElement)).toBe(false);
    expect(container).toBeTruthy();
  });

  it("keeps every row of the editor inside the mobile content width", () => {
    const { container } = render(<AgentsWorkshopView />);

    expect(rowsWiderThanMobile(container)).toEqual([]);
    expect(gridsWiderThanMobile(container)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* /projects/:id/sessions — the list                                   */
/* ------------------------------------------------------------------ */

async function renderSessions() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            kind: "agent_session",
            id: "sess-running",
            status: "running",
            mode: "code",
            provider: "claude-code",
            agentType: "build",
            branchName: "feature/epic-overflow",
            startedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
          },
        ],
      }),
    }))
  );
  const view = render(<SessionsPage />);
  await waitFor(() =>
    expect(screen.queryByText("Loading sessions...")).not.toBeInTheDocument()
  );
  return view;
}

describe("Sessions list at a 390px viewport", () => {
  it("wraps the synthesis band and the filter bar", async () => {
    await renderSessions();

    expect(isNonWrappingRow(screen.getByTestId("sessions-band"))).toBe(false);

    const filterBar = screen.getByTestId("sessions-filter-all")
      .parentElement as HTMLElement;
    expect(isNonWrappingRow(filterBar)).toBe(false);
  });

  it("lets the ticket filter shrink instead of pinning 150px", async () => {
    await renderSessions();

    const input = screen.getByPlaceholderText("Filter by ticket");
    expect(fixedWidthPx(input)).toBe(0);
  });

  it("keeps every row of the screen inside the mobile content width", async () => {
    const { container } = await renderSessions();

    expect(rowsWiderThanMobile(container)).toEqual([]);
    expect(gridsWiderThanMobile(container)).toEqual([]);
  });
});
