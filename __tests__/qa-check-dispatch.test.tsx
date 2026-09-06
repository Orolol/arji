/**
 * The capability the redesign lost, on the screen the nav actually opens.
 *
 * `/qa` is where "QA" leads in the top bar. It described only the REVIEW layer
 * — sessions bound to a ticket and the findings they file — while Tech Check,
 * E2E Test and Failure Digest stayed behind on `/projects/:id/qa`, reachable
 * from the desk's icon-only project-pages dropdown and from nowhere else. This
 * file pins the entry point that puts them back: who may be offered, what the
 * click dispatches, and where the user is told to look for the report.
 *
 * The DIALOG itself is not this packet's, and is unchanged:
 * `__tests__/qa-components.test.tsx` pins its POST body and
 * `__tests__/qa-check-route.test.ts` pins the three check kinds the route
 * launches. What is pinned here is the path from this screen into it.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QaScreen } from "@/components/qa/QaScreen";
import type { QaCheck, QaPayload } from "@/lib/qa/types";

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select" />,
}));

function deskProject(id: string, name: string, colorIndex: number) {
  return {
    id,
    name,
    shortName: name.toUpperCase(),
    colorIndex,
    activeAgents: 0,
    autoModeEnabled: false,
  };
}

function check(overrides: Partial<QaCheck> = {}): QaCheck {
  return {
    reportId: "r1",
    projectId: "p1",
    checkType: "tech_check",
    checkLabel: "TECH",
    status: "completed",
    live: false,
    summary: "Two uncapped columns on agent_sessions.",
    agentSessionId: "s1",
    createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    completedAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

function payload(overrides: Partial<QaPayload> = {}): QaPayload {
  return {
    generatedAt: "2026-09-06T09:00:00.000Z",
    projects: [deskProject("p1", "Arij", 0)],
    runs: [],
    queued: [],
    findings: [],
    verdicts: [],
    rubric: { items: ["Tests"], projectRuleCount: 0 },
    reviewable: [],
    checks: [],
    checkableProjectIds: ["p1"],
    coveragePercent: 92,
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
let startResponse: unknown;

/**
 * URL-AWARE, not a queue. A queued mock replays the POST's own response for the
 * `/api/qa/prompts` read the dialog fires when it opens, which is exactly the
 * flake shape `__tests__/refinement-button.test.tsx` documents.
 */
function installFetch(data: QaPayload): void {
  calls = [];
  startResponse = { reportId: "rep-9", sessionId: "sess-9" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url === "/api/qa/findings") {
        return new Response(JSON.stringify({ data }), { status: 200 });
      }
      if (url === "/api/qa/prompts") {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.includes("/qa/check")) {
        return new Response(JSON.stringify({ data: startResponse }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }),
  );
}

async function renderScreen(data: QaPayload = payload()) {
  installFetch(data);
  const result = render(<QaScreen />);
  await waitFor(() =>
    expect(screen.getByTestId("qa-new-check")).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(screen.queryAllByTestId("qa-check-row")).toHaveLength(
      data.checks.length,
    ),
  );
  return result;
}

function checkPosts(): Call[] {
  return calls.filter(
    (call) => call.method === "POST" && call.url.includes("/qa/check"),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("QaScreen — the QA CHECKS band", () => {
  it("draws each check as a link into the report that draws it", async () => {
    await renderScreen(
      payload({
        checks: [
          check({ reportId: "rep-1", projectId: "p1" }),
          check({
            reportId: "rep-2",
            projectId: "p1",
            checkType: "e2e_test",
            checkLabel: "E2E",
            status: "running",
            live: true,
            summary: null,
          }),
        ],
      }),
    );

    const rows = screen.getAllByTestId("qa-check-row");
    expect(rows).toHaveLength(2);
    // `?reportId=` is the parameter `/projects/:id/qa` consumes to select a
    // report; the report document is that screen's, not this one's.
    expect(rows[0]).toHaveAttribute("href", "/projects/p1/qa?reportId=rep-1");
    expect(rows[1]).toHaveAttribute("href", "/projects/p1/qa?reportId=rep-2");
    expect(rows[1]).toHaveAttribute("data-status", "running");
    expect(within(rows[1]).getByText("E2E")).toBeInTheDocument();
  });

  it("counts the running checks in the band header", async () => {
    await renderScreen(
      payload({
        checks: [
          check({ reportId: "a", status: "running", live: true }),
          check({ reportId: "b" }),
          check({ reportId: "c", status: "failed" }),
        ],
      }),
    );

    // One of the three is live: the meta counts `live`, not rows.
    expect(screen.getByText("1 running · 3 recent")).toBeInTheDocument();
  });

  it("folds to its label line with no check at all", async () => {
    await renderScreen();

    expect(screen.queryAllByTestId("qa-check-row")).toHaveLength(0);
    expect(screen.getByText("0 running · 0 recent")).toBeInTheDocument();
    // The button is still there: an empty history is the state you start a
    // check FROM, so this is the one place it must not be hidden.
    expect(screen.getByTestId("qa-new-check")).toBeEnabled();
  });
});

describe("QaScreen — New check", () => {
  /**
   * `POST /api/projects/{p}/qa/check` is `requireGitRepo: true` and 400s
   * without a `git_repo_path`, so the payload decides who is offerable and the
   * button never offers a dispatch the route would refuse — the same rule
   * `reviewable` follows for "Run QA pass".
   */
  it("is disabled when no project has a git repository", async () => {
    await renderScreen(payload({ checkableProjectIds: [] }));

    expect(screen.getByTestId("qa-new-check")).toBeDisabled();
  });

  it("opens the dialog straight away with a single checkable project", async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByTestId("qa-new-check"));

    // No menu: one row asking a question with a single answer is a click for
    // nothing.
    expect(screen.queryByTestId("qa-new-check-menu")).not.toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Start Tech Check" }),
    ).toBeInTheDocument();
  });

  it("asks which project when several are checkable, and scopes the dispatch to it", async () => {
    const user = userEvent.setup();
    await renderScreen(
      payload({
        projects: [deskProject("p1", "Arij", 0), deskProject("p2", "Ledger", 1)],
        checkableProjectIds: ["p1", "p2"],
      }),
    );

    await user.click(screen.getByTestId("qa-new-check"));
    const options = await screen.findAllByTestId("qa-new-check-project");
    expect(options).toHaveLength(2);

    await user.click(options[1]);
    await user.click(
      await screen.findByRole("button", { name: "Start Tech Check" }),
    );

    await waitFor(() => expect(checkPosts()).toHaveLength(1));
    expect(checkPosts()[0].url).toBe("/api/projects/p2/qa/check");
    expect(checkPosts()[0].body).toMatchObject({ checkType: "tech_check" });
  });

  it("offers only the checkable projects, never every project", async () => {
    const user = userEvent.setup();
    await renderScreen(
      payload({
        projects: [
          deskProject("p1", "Arij", 0),
          deskProject("p2", "Ledger", 1),
          deskProject("p3", "Norepo", 2),
        ],
        checkableProjectIds: ["p1", "p3"],
      }),
    );

    await user.click(screen.getByTestId("qa-new-check"));
    const options = await screen.findAllByTestId("qa-new-check-project");

    expect(options.map((option) => option.textContent)).toEqual([
      "ARIJArij",
      "NOREPONorepo",
    ]);
  });

  it("hands the user the report link once the check is accepted", async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByTestId("qa-new-check"));
    await user.click(
      await screen.findByRole("button", { name: "Start Tech Check" }),
    );

    const toast = await screen.findByTestId("qa-toast");
    expect(toast).toHaveTextContent("QA check lancé");
    expect(within(toast).getByRole("link")).toHaveAttribute(
      "href",
      "/projects/p1/qa?reportId=rep-9",
    );
  });

  /**
   * An empty failure-digest window is journalled as a COMPLETED report with no
   * agent session at all. Saying "QA check lancé" would promise a run that will
   * never appear in QA RUNS or in the band.
   */
  it("says nothing was launched when the digest window was empty", async () => {
    const user = userEvent.setup();
    await renderScreen();
    startResponse = { reportId: "rep-0", sessionId: null, noOp: true };

    await user.click(screen.getByTestId("qa-new-check"));
    await user.click(
      await screen.findByRole("button", { name: "Start Tech Check" }),
    );

    const toast = await screen.findByTestId("qa-toast");
    expect(toast).toHaveTextContent("aucun agent lancé");
    expect(within(toast).getByRole("link")).toHaveAttribute(
      "href",
      "/projects/p1/qa?reportId=rep-0",
    );
  });

  it("re-reads the payload so a started check reaches the band", async () => {
    const user = userEvent.setup();
    await renderScreen();
    const before = calls.filter((call) => call.url === "/api/qa/findings").length;

    await user.click(screen.getByTestId("qa-new-check"));
    await user.click(
      await screen.findByRole("button", { name: "Start Tech Check" }),
    );

    await waitFor(() =>
      expect(
        calls.filter((call) => call.url === "/api/qa/findings").length,
      ).toBeGreaterThan(before),
    );
  });
});
