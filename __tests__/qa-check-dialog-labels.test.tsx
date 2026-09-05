import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { StartQaCheckDialog } from "@/components/qa/StartQaCheckDialog";

/**
 * The QA check dialog is the only entry point to a tech check, an E2E run or a
 * failure digest, and every one of its fields carried a visual <label> with no
 * `htmlFor` that wrapped no control — so the field was unnamed to assistive
 * technology.
 *
 * Every assertion here goes through the accessible name (`getByLabelText`,
 * `getByRole(..., { name })`). A test-id query would pass while the
 * association stayed broken, which is exactly the regression this file exists
 * to catch.
 *
 * `NamedAgentSelect` is rendered for real — only its two data hooks are
 * stubbed — because the "Named Agent (optional)" association runs through that
 * shared component's own prop surface.
 */

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: [{ id: "agent-1", name: "Scout" }],
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/hooks/useDispatchReliability", () => ({
  useDispatchReliability: () => ({
    byAgentId: new Map(),
    windowDays: 30,
    minSample: 5,
    loading: false,
  }),
}));

describe("Start QA check dialog accessibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/qa/prompts") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                { id: "prompt-1", name: "Security", prompt: "Check security" },
              ],
            }),
        }) as Promise<Response>;
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      }) as Promise<Response>;
    }) as typeof fetch;
  });

  // The dialog loads its saved prompts on open, so the render is awaited: it
  // settles that fetch's state update inside act() instead of letting it land
  // after the test body.
  async function renderDialog() {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <StartQaCheckDialog
          projectId="proj-1"
          open
          onOpenChange={vi.fn()}
          onStarted={vi.fn()}
        />,
      );
    });
    return result;
  }

  it("names the check type select through its visible label", async () => {
    await renderDialog();

    expect(screen.getByLabelText("Check Type")).toBe(
      screen.getByRole("combobox", { name: "Check Type" }),
    );
  });

  it("names the named-agent picker through its visible label", async () => {
    await renderDialog();

    expect(screen.getByLabelText("Named Agent (optional)")).toBe(
      screen.getByRole("combobox", { name: "Named Agent (optional)" }),
    );
  });

  it("exposes the default-agent hint as the picker's description", async () => {
    await renderDialog();

    expect(
      screen.getByRole("combobox", { name: "Named Agent (optional)" }),
    ).toHaveAccessibleDescription(
      "No agent selected: Arij will automatically use the configured default.",
    );
  });

  it("names the saved-prompt select through its visible label", async () => {
    await renderDialog();

    expect(screen.getByLabelText("Saved Prompt")).toBe(
      screen.getByRole("combobox", { name: "Saved Prompt" }),
    );
  });

  it("names the custom prompt textarea through its visible label", async () => {
    await renderDialog();

    expect(screen.getByLabelText("Custom Prompt (optional)")).toBe(
      screen.getByPlaceholderText("Add custom QA instructions..."),
    );
  });

  it("leaves no label in the dialog that names nothing", async () => {
    const { baseElement } = await renderDialog();

    const orphans = Array.from(baseElement.querySelectorAll("label")).filter(
      (label) =>
        !label.getAttribute("for") &&
        !label.querySelector(
          "button, input, meter, output, progress, select, textarea",
        ),
    );

    expect(orphans.map((label) => label.textContent)).toEqual([]);
  });

  // Control: this assertion holds on both sides of the fix, so a red run of
  // the cases above is about the label association and not about the dialog
  // failing to render at all.
  it("still renders the dialog's primary action", async () => {
    await renderDialog();

    expect(
      screen.getByRole("button", { name: "Start Tech Check" }),
    ).toBeInTheDocument();
  });
});
