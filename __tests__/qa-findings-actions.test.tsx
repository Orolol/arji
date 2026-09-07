/**
 * The three writes frame 11b makes, and the one it refuses to make blind.
 *
 * Nothing on this screen approves a ticket or moves a status: Fix dispatches a
 * build, Dismiss resolves ONE finding and records why, Run QA pass dispatches
 * ONE review on ONE ticket.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QaScreen } from "@/components/qa/QaScreen";
import type { QaFinding, QaPayload } from "@/lib/qa/types";

function finding(overrides: Partial<QaFinding> = {}): QaFinding {
  return {
    findingId: "f1",
    epicId: "e1",
    projectId: "p1",
    readableId: "ARJ-113",
    ticketTitle: "Named agents",
    text: "Le token MCP est loggé en clair quand la session échoue",
    filePath: "lib/agents/session.ts",
    lineNumber: 214,
    severity: "critical",
    severityLabel: "BLOCKING",
    tier: "blocking",
    blocking: true,
    reviewer: "Security CC",
    reviewerAgentType: "review_security",
    filedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    fixable: true,
    rawBody: "[critical] Le token MCP est loggé en clair quand la session échoue",
    ...overrides,
  };
}

function payload(overrides: Partial<QaPayload> = {}): QaPayload {
  return {
    generatedAt: "2026-08-30T09:00:00.000Z",
    projects: [
      {
        id: "p1",
        name: "Arij",
        shortName: "ARIJ",
        colorIndex: 0,
        activeAgents: 0,
        autoModeEnabled: false,
      },
    ],
    runs: [],
    queued: [],
    findings: [finding()],
    verdicts: [],
    rubric: { items: ["Tests"], projectRuleCount: 0 },
    reviewable: [
      {
        epicId: "e7",
        projectId: "p1",
        readableId: "ARJ-140",
        title: "Prompt anatomy route",
        status: "review",
      },
    ],
    checks: [],
    checkTotals: {},
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
let responders: Map<string, () => Response>;

function ok(data: unknown = {}): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function installFetch(data: QaPayload = payload()): void {
  calls = [];
  responders = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url === "/api/qa/findings") return ok(data);
      const responder = [...responders.entries()].find(([key]) =>
        url.includes(key),
      )?.[1];
      return responder ? responder() : ok();
    }),
  );
}

async function renderScreen(data: QaPayload = payload()) {
  installFetch(data);
  const result = render(<QaScreen />);
  await waitFor(() => expect(screen.getByTestId("qa-coverage")).toBeInTheDocument());
  await waitFor(() =>
    expect(screen.queryAllByTestId("qa-finding-row").length).toBe(
      data.findings.length,
    ),
  );
  return result;
}

function writesTo(fragment: string): Call[] {
  return calls.filter((call) => call.method !== "GET" && call.url.includes(fragment));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("QaScreen — the coverage stat", () => {
  it("prints the percentage", async () => {
    await renderScreen();
    expect(screen.getByTestId("qa-coverage").textContent).toBe(
      "review coverage 92% · 30d",
    );
  });

  it("prints an em-dash — never 0% — when nothing shipped in the window", async () => {
    await renderScreen(payload({ coveragePercent: null }));
    expect(screen.getByTestId("qa-coverage").textContent).toBe(
      "review coverage — · 30d",
    );
  });
});

describe("QaScreen — Fix with agent", () => {
  it("posts the ReviewActions markdown to the epic build route", async () => {
    await renderScreen();
    fireEvent.click(screen.getByTestId("qa-finding-fix"));

    await waitFor(() => expect(writesTo("/build")).toHaveLength(1));
    const call = writesTo("/build")[0];
    expect(call.url).toBe("/api/projects/p1/epics/e1/build");
    const comment = String(call.body?.comment);
    expect(comment).toContain("## Review Comments");
    expect(comment).toContain("### lib/agents/session.ts");
    expect(comment).toContain("- **Line 214**: [critical] Le token MCP");
    // No named agent, and no `pipeline`: the server's setting chain decides.
    expect(call.body).not.toHaveProperty("namedAgentId");
    expect(call.body).not.toHaveProperty("pipeline");
  });

  it("raises a toast with a link to the session that is in the way on 409", async () => {
    await renderScreen();
    responders.set(
      "/build",
      () =>
        new Response(
          JSON.stringify({
            error: "Another agent is already running for this epic.",
            code: "AGENT_ALREADY_RUNNING",
            data: {
              activeSessionId: "s9",
              sessionUrl: "/projects/p1/sessions/s9",
            },
          }),
          { status: 409 },
        ),
    );

    fireEvent.click(screen.getByTestId("qa-finding-fix"));
    const toast = await screen.findByTestId("qa-toast");
    expect(toast.textContent).toContain("Another agent is already running");
    expect(within(toast).getByRole("link")).toHaveAttribute(
      "href",
      "/projects/p1/sessions/s9",
    );
  });
});

describe("QaScreen — Dismiss", () => {
  it("refuses to write until a reason is typed, then makes both writes", async () => {
    await renderScreen();
    fireEvent.click(screen.getByTestId("qa-finding-dismiss"));

    const confirm = await screen.findByTestId("qa-dismiss-confirm");
    expect(confirm).toBeDisabled();
    // A blank reason is a silently-lost finding: nothing is written.
    fireEvent.click(confirm);
    expect(writesTo("review-comments")).toHaveLength(0);

    fireEvent.change(screen.getByTestId("qa-dismiss-reason"), {
      target: { value: "  déjà corrigé ailleurs  " },
    });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(writesTo("review-comments")).toHaveLength(1));
    const patch = writesTo("review-comments")[0];
    expect(patch.method).toBe("PATCH");
    expect(patch.url).toBe("/api/projects/p1/epics/e1/review-comments");
    expect(patch.body).toMatchObject({ id: "f1", status: "resolved" });
    // The reason lives in `body` because no column exists for it, appended to
    // the TAIL so the leading severity prefix — and therefore the row's
    // classification — is untouched.
    expect(String(patch.body?.body)).toBe(
      "[critical] Le token MCP est loggé en clair quand la session échoue\n\n[dismissed] déjà corrigé ailleurs",
    );

    await waitFor(() => expect(writesTo("/comments")).toHaveLength(1));
    const echo = writesTo("/comments")[0];
    expect(echo.body).toMatchObject({ author: "user" });
    expect(String(echo.body?.content)).toContain(
      "**Finding dismissed** on `lib/agents/session.ts:214`",
    );
    expect(String(echo.body?.content)).toContain("déjà corrigé ailleurs");
  });

  it("keeps the dismissal and warns when only the ticket echo fails", async () => {
    await renderScreen();
    responders.set(
      "/comments",
      () => new Response(JSON.stringify({ error: "nope" }), { status: 400 }),
    );

    fireEvent.click(screen.getByTestId("qa-finding-dismiss"));
    fireEvent.change(await screen.findByTestId("qa-dismiss-reason"), {
      target: { value: "faux positif" },
    });
    fireEvent.click(screen.getByTestId("qa-dismiss-confirm"));

    const toast = await screen.findByTestId("qa-toast");
    expect(toast.textContent).toContain(
      "Finding dismissed, but the reason was not recorded on the ticket",
    );
    // The finding stays resolved: losing the dismissal is worse than losing
    // its echo, so nothing is rolled back.
    expect(writesTo("review-comments")).toHaveLength(1);
  });

  it("submits on ⏎ in the reason field", async () => {
    await renderScreen();
    fireEvent.click(screen.getByTestId("qa-finding-dismiss"));
    const field = await screen.findByTestId("qa-dismiss-reason");
    fireEvent.change(field, { target: { value: "hors scope" } });
    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(writesTo("review-comments")).toHaveLength(1));
  });
});

describe("QaScreen — Run QA pass", () => {
  it("dispatches one feature_review on the ticket the user picks", async () => {
    const user = userEvent.setup();
    await renderScreen();

    await user.click(screen.getByTestId("qa-run-pass"));
    const target = await screen.findByTestId("qa-run-pass-target");
    await user.click(target);

    await waitFor(() => expect(writesTo("/review")).toHaveLength(1));
    const call = writesTo("/review")[0];
    expect(call.url).toBe("/api/projects/p1/epics/e7/review");
    // ONE review type: the route creates one session per type, so four types
    // would be four agents on one ticket.
    expect(call.body).toEqual({ reviewTypes: ["feature_review"] });
  });

  it("disables the pill when no ticket is eligible", async () => {
    await renderScreen(payload({ reviewable: [] }));
    expect(screen.getByTestId("qa-run-pass")).toBeDisabled();
  });
});
