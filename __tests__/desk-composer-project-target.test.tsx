/**
 * Which project the desk composer writes into — and how a test says so.
 *
 * On `/projects/:id` the composer inherits the route's project. On `/` there
 * is no such project, so `DeskComposer` falls back to `projects[0]`. That
 * fallback is deliberate product behaviour for a single-user workspace and it
 * stays; what it is NOT is a promise about *which* project that is.
 *
 * `e2e/desk-toasts.spec.ts` used to lean on it: it navigated to `/`, typed a
 * title, then read the epic back scoped to its own fixture project. Under
 * `fullyParallel` / `workers: 4` the shared e2e database also holds the other
 * workers' projects, so `projects[0]` was a neighbour's, the ticket was
 * created there, and the scoped read came back `undefined` — while the toast,
 * which knows nothing about which project it wrote to, showed up as usual.
 *
 * The repair is for the spec to target its project explicitly, which needs a
 * handle on the pill: its label is the *current* project's `shortName`, a
 * value the test cannot know in advance. Hence the test id pinned below.
 */

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@/components/ui/dropdown-menu", async () => {
  const { dropdownMenuModuleMock } = await import(
    "@/__tests__/helpers/dropdown-menu-mock"
  );
  return dropdownMenuModuleMock();
});

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

import { DeskComposer } from "@/components/desk/DeskComposer";
import type { DeskProject } from "@/lib/control-desk/types";

/** The handle `e2e/desk-toasts.spec.ts` opens the project pill with. */
const PROJECT_SELECT_TESTID = "desk-project-select";

function deskProject(id: string, name: string, shortName: string): DeskProject {
  return {
    id,
    name,
    shortName,
    colorIndex: 0,
    activeAgents: 0,
    autoModeEnabled: false,
  };
}

/**
 * Two projects, as the cross-project desk sees a workspace with more than one
 * — which is the whole condition of the bug. `neighbour` is first on purpose:
 * it is the one an untargeted composer writes into.
 */
const NEIGHBOUR = deskProject("p-neighbour", "Neighbour worker", "NEIG");
const MINE = deskProject("p-mine", "My own project", "MINE");

function renderComposer(targetProjectId: string | null) {
  const onTargetProjectChange = vi.fn();
  const onSubmit = vi.fn().mockResolvedValue(true);
  render(
    <DeskComposer
      projects={[NEIGHBOUR, MINE]}
      targetProjectId={targetProjectId}
      onTargetProjectChange={onTargetProjectChange}
      namedAgentId={null}
      onNamedAgentChange={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  return { onTargetProjectChange, onSubmit };
}

async function type(title: string) {
  const input = screen.getByRole("textbox", { name: "Décris une feature" });
  // `act`, because the submit handler is async: it flips `busy` on either side
  // of an awaited `onSubmit` and clears the title on success, so three state
  // updates land after the event returns.
  await act(async () => {
    fireEvent.change(input, { target: { value: title } });
    fireEvent.keyDown(input, { key: "Enter" });
  });
}

describe("DeskComposer project target", () => {
  it("writes into the first project when nothing is targeted", async () => {
    // The documented fallback, kept as a control: it is reasonable product
    // behaviour and this change does not touch it.
    const { onSubmit } = renderComposer(null);

    await type("Une feature");

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: NEIGHBOUR.id }),
    );
  });

  it("exposes the project pill under a stable test id", () => {
    // Its visible label is the current project's shortName, so a test that has
    // to CHANGE the target cannot address the trigger by its text.
    renderComposer(null);

    const pill = screen.getByTestId(PROJECT_SELECT_TESTID);
    expect(pill.tagName).toBe("BUTTON");
    expect(pill).toHaveTextContent(NEIGHBOUR.shortName);
  });

  it("lists every project by full name, so a chooser can name one", () => {
    // The pill's own label is abbreviated; the menu is where a project is
    // addressable by the name a fixture knows it under.
    renderComposer(null);

    expect(
      screen.getByRole("menuitem", { name: MINE.name }),
    ).toBeInTheDocument();
  });

  it("retargets the composer when another project is chosen", () => {
    const { onTargetProjectChange } = renderComposer(null);

    fireEvent.click(screen.getByRole("menuitem", { name: MINE.name }));

    expect(onTargetProjectChange).toHaveBeenCalledWith(MINE.id);
  });

  it("writes into the targeted project rather than the first one", async () => {
    const { onSubmit } = renderComposer(MINE.id);

    await type("Une feature");

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: MINE.id }),
    );
  });
});

describe("e2e/desk-toasts.spec.ts", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "e2e", "desk-toasts.spec.ts"),
    "utf8",
  );

  /**
   * Everything the global-scope run does between landing on `/` and typing its
   * title. Proving the containment here — rather than anywhere in the file —
   * is what says the project was targeted BEFORE the ticket was written.
   */
  const beforeTyping = source.slice(
    source.indexOf("await page.goto("),
    source.indexOf("await input.fill("),
  );

  it("targets its own project before typing, on the cross-project desk", () => {
    expect(beforeTyping).toContain(PROJECT_SELECT_TESTID);
    expect(beforeTyping).toMatch(/name:\s*project\.name/);
  });

  it("does the targeting only where there is no project in the route", () => {
    // `/projects/:id` inherits its own project, and that default is worth
    // keeping under test — so the selection is the `global` branch's alone.
    // `indexOf` returning -1 for a missing guard slices to the last character,
    // which contains nothing: an unguarded selection fails here.
    const guarded = beforeTyping.slice(
      beforeTyping.indexOf('if (scope === "global")'),
    );
    expect(guarded).toContain(PROJECT_SELECT_TESTID);
  });
});
