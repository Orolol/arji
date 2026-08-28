/**
 * Live provider-quota cards on the usage observatory.
 *
 * These pin the third source of truth: what the provider's own CLI answered
 * to a metadata read. The invariants under test are honesty invariants —
 * every percentage on screen was emitted by the provider, the Arij meter is
 * labelled as this-machine-only rather than blended in, and a failed poll
 * degrades to the existing fallback bodies with an explicit sentence instead
 * of silently looking identical.
 *
 * Fixtures are hand-written to the §1a/§2c pinned wire shapes; the page
 * imports those types via `import type` only, so this file pins the contract
 * independently of the poller builder.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import UsagePage from "@/app/usage/page";
import type {
  CodexQuotaBucket,
  SubscriptionStatus,
  UsageReport,
} from "@/lib/types/usage";

/** Frozen "now": 2026-08-18 12:00 UTC — the report's own generatedAt. */
const FIXED_NOW = Date.parse("2026-08-18T12:00:00.000Z");
const NOW_SEC = Math.floor(FIXED_NOW / 1000);

const CLAUDE_METERED = {
  last5h: { sessions: 1, inputTokens: 1_000_000, outputTokens: 8_000, costUsd: 1.2 },
  last7d: {
    sessions: 5,
    inputTokens: 40_000_000,
    outputTokens: 300_000,
    costUsd: 30,
  },
  budgetUsdWeek: 50,
  budgetUsedPercent: 60,
};

const CLAUDE_LIVE_SUB: SubscriptionStatus = {
  provider: "claude-code",
  source: "provider-reported",
  sourceDetail: "live-cli",
  plan: "max",
  capturedAt: "2026-08-18T11:58:00.000Z", // 2m before FIXED_NOW
  primary: null,
  secondary: null,
  metered: CLAUDE_METERED,
  claudeLive: {
    subscriptionType: "max",
    fiveHour: { utilizationPercent: 34, resetsAtIso: "2026-08-18T16:00:00+00:00" },
    sevenDay: { utilizationPercent: 61, resetsAtIso: "2026-08-21T09:00:00+00:00" },
    sevenDayOpus: { utilizationPercent: 12, resetsAtIso: "2026-08-21T09:00:00+00:00" },
    sevenDaySonnet: null,
    modelScoped: [
      {
        displayName: "Opus 4.5",
        utilizationPercent: 12,
        resetsAtIso: "2026-08-21T09:00:00+00:00",
      },
    ],
    extraUsage: {
      isEnabled: true,
      monthlyLimit: 100,
      usedCredits: 12.5,
      utilizationPercent: 12.5,
    },
  },
  codexLive: null,
};

const CLAUDE_FALLBACK_SUB: SubscriptionStatus = {
  provider: "claude-code",
  source: "metered-via-arij",
  sourceDetail: "arij-sessions",
  plan: null,
  capturedAt: null,
  primary: null,
  secondary: null,
  metered: CLAUDE_METERED,
  claudeLive: null,
  codexLive: null,
};

const CODEX_LIVE_SUB: SubscriptionStatus = {
  provider: "codex",
  source: "provider-reported",
  sourceDetail: "live-cli",
  plan: "prolite",
  capturedAt: "2026-08-18T11:58:00.000Z",
  primary: { usedPercent: 6, windowMinutes: 10080, resetsAt: NOW_SEC + 3 * 86400 },
  secondary: null,
  metered: null,
  claudeLive: null,
  codexLive: {
    planType: "prolite",
    buckets: [
      {
        limitId: "codex",
        limitName: null,
        usedPercent: 6,
        windowDurationMins: 10080,
        resetsAtUnix: NOW_SEC + 3 * 86400,
        secondary: null,
      },
      {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        usedPercent: 2,
        windowDurationMins: 10080,
        resetsAtUnix: NOW_SEC + 3 * 86400,
        secondary: null,
      },
    ],
    credits: { hasCredits: false, unlimited: false, balance: "0" },
    dailyUsage: [
      { date: "2026-08-15", tokens: 26_808_416 },
      { date: "2026-08-16", tokens: 69_212_904 },
      { date: "2026-08-17", tokens: 41_972_937 },
      { date: "2026-08-18", tokens: 20_928_692 },
    ],
    lifetimeTokens: 1_383_498_631,
  },
};

/** Today's rollout-snapshot codex card, unchanged apart from the new keys. */
const CODEX_SNAPSHOT_SUB: SubscriptionStatus = {
  provider: "codex",
  source: "provider-reported",
  sourceDetail: "rollout-snapshot",
  plan: "prolite",
  capturedAt: "2026-08-18T10:00:00.000Z",
  primary: {
    usedPercent: 6,
    windowMinutes: 300,
    resetsAt: NOW_SEC + 4 * 3600 + 12 * 60,
  },
  secondary: null,
  metered: null,
  claudeLive: null,
  codexLive: null,
};

const CODEX_EMPTY_SUB: SubscriptionStatus = {
  provider: "codex",
  source: "provider-reported",
  sourceDetail: "rollout-snapshot",
  plan: null,
  capturedAt: null,
  primary: null,
  secondary: null,
  metered: null,
  claudeLive: null,
  codexLive: null,
};

function codexSubWith(
  patch: Partial<NonNullable<SubscriptionStatus["codexLive"]>>
): SubscriptionStatus {
  return {
    ...CODEX_LIVE_SUB,
    codexLive: { ...CODEX_LIVE_SUB.codexLive!, ...patch },
  };
}

function claudeSubWith(
  patch: Partial<NonNullable<SubscriptionStatus["claudeLive"]>>
): SubscriptionStatus {
  return {
    ...CLAUDE_LIVE_SUB,
    claudeLive: { ...CLAUDE_LIVE_SUB.claudeLive!, ...patch },
  };
}

/**
 * Minimal report: one recorded session so the page renders its lower
 * sections (the Arij 30-day strip in particular, which the codex history
 * strip must stay visually distinct from).
 *
 * The `dashboard` block below is the ONLY change this file received for the
 * frame-8d re-skin: `UsageReport` gained a required ninth key, so the fixture
 * has to carry one. Not one assertion in this file changed — it is still the
 * proof that the subscription-card subtree moved verbatim.
 */
function report(subscriptions: SubscriptionStatus[]): UsageReport {
  return {
    totals: { sessions: 1, inputTokens: 1_000, outputTokens: 100, costUsd: 1 },
    byAgent: [],
    byProvider: [],
    byProject: [],
    byDay: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      sessions: i === 29 ? 1 : 0,
      costUsd: i === 29 ? 1 : null,
    })),
    windows: {
      last5h: { sessions: 1, inputTokens: 1_000, outputTokens: 100, costUsd: 1 },
      last7d: { sessions: 1, inputTokens: 1_000, outputTokens: 100, costUsd: 1 },
    },
    subscriptions,
    generatedAt: "2026-08-18T12:00:00.000Z",
    dashboard: {
      range: "30d",
      since: "2026-07-19T12:00:00.000Z",
      totals: {
        costUsd: 1,
        sessions: 1,
        cleanPercent: 100,
        ticketsShipped: 0,
        costPerTicketUsd: null,
      },
      cap: { capUsd: null, spentUsd: 1, usedPercent: null, alertPercent: 80 },
      byAgent: [],
      byProject: [],
      byDay: Array.from({ length: 30 }, (_, i) => ({
        date: `2026-08-${String(i + 1).padStart(2, "0")}`,
        sessions: i === 29 ? 1 : 0,
        costUsd: i === 29 ? 1 : null,
        failedSessions: 0,
      })),
      nightYesterdayUsd: null,
    },
  };
}

function mockUsage(usageReport: UsageReport) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: usageReport }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* Claude — live                                                              */
/* -------------------------------------------------------------------------- */

describe("Usage page — claude live quota", () => {
  it("renders the account windows the provider reported, not Arij's meter", async () => {
    mockUsage(report([CLAUDE_LIVE_SUB]));
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-claude-code-source")
    ).toHaveTextContent("Provider-reported");
    expect(screen.getByTestId("usage-sub-claude-code")).toHaveTextContent(
      "plan: max"
    );

    expect(
      screen.getByTestId("usage-sub-claude-live-5h-readout")
    ).toHaveTextContent("34%");
    expect(screen.getByTestId("usage-sub-claude-live-5h-fill")).toHaveStyle({
      width: "34%",
    });
    expect(
      screen.getByTestId("usage-sub-claude-live-7d-readout")
    ).toHaveTextContent("61%");
    expect(screen.getByTestId("usage-sub-claude-live-7d-fill")).toHaveStyle({
      width: "61%",
    });
  });

  it("counts down from the ISO reset stamp claude emits", async () => {
    mockUsage(report([CLAUDE_LIVE_SUB]));
    render(<UsagePage />);

    // 2026-08-18T16:00Z is 4h after the report's generatedAt.
    expect(
      await screen.findByTestId("usage-sub-claude-live-5h-reset")
    ).toHaveTextContent("resets in 4h 0m");
    // 2026-08-21T09:00Z is 2d 21h out.
    expect(screen.getByTestId("usage-sub-claude-live-7d-reset")).toHaveTextContent(
      "resets in 2d 21h"
    );
  });

  it("calls an elapsed window stale rather than rolling it forward", async () => {
    mockUsage(
      report([
        claudeSubWith({
          fiveHour: {
            utilizationPercent: 34,
            resetsAtIso: "2026-08-18T11:00:00+00:00",
          },
        }),
      ])
    );
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-claude-live-5h-reset")
    ).toHaveTextContent("window expired — data stale");
    expect(screen.getByTestId("usage-sub-claude-live-5h-fill")).toHaveStyle({
      opacity: "0.35",
    });
    // The reported utilization is still replayed verbatim.
    expect(
      screen.getByTestId("usage-sub-claude-live-5h-readout")
    ).toHaveTextContent("34%");
  });

  it("says the reset time is unknown instead of inventing one", async () => {
    mockUsage(
      claudeReport({ fiveHour: { utilizationPercent: 34, resetsAtIso: null } })
    );
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-claude-live-5h-reset")
    ).toHaveTextContent("reset time unknown");
  });

  it("renders the optional model windows only when the provider sent them", async () => {
    mockUsage(report([CLAUDE_LIVE_SUB]));
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-claude-live-7d-opus-readout")
    ).toHaveTextContent("12%");
    expect(
      screen.queryByTestId("usage-sub-claude-live-7d-sonnet")
    ).not.toBeInTheDocument();
  });

  it("labels each model_scoped row with the provider's display name", async () => {
    mockUsage(
      claudeReport({
        modelScoped: [
          {
            displayName: "Opus 4.5",
            utilizationPercent: 12,
            resetsAtIso: "2026-08-21T09:00:00+00:00",
          },
          {
            displayName: "Sonnet 4.5",
            utilizationPercent: 3,
            resetsAtIso: "2026-08-21T09:00:00+00:00",
          },
        ],
      })
    );
    render(<UsagePage />);

    // The fixture already shows Opus as the named "7D OPUS" window — its
    // model_scoped twin is deduplicated, so Sonnet is the first model row.
    const first = await screen.findByTestId("usage-sub-claude-live-model-0");
    expect(first).toHaveTextContent("SONNET 4.5");
    expect(
      screen.getByTestId("usage-sub-claude-live-model-0-readout")
    ).toHaveTextContent("3%");
    expect(screen.getByTestId("usage-sub-claude-live-7d-opus")).toHaveTextContent(
      "7D OPUS"
    );
    expect(screen.queryByText("OPUS 4.5")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("usage-sub-claude-live-model-1")
    ).not.toBeInTheDocument();
  });

  it("keeps a model row when no named window already covers that model", async () => {
    mockUsage(
      claudeReport({
        sevenDayOpus: null,
        modelScoped: [
          {
            displayName: "Opus 4.5",
            utilizationPercent: 12,
            resetsAtIso: "2026-08-21T09:00:00+00:00",
          },
        ],
      })
    );
    render(<UsagePage />);

    const row = await screen.findByTestId("usage-sub-claude-live-model-0");
    expect(row).toHaveTextContent("OPUS 4.5");
    expect(
      screen.getByTestId("usage-sub-claude-live-model-0-readout")
    ).toHaveTextContent("12%");
  });

  it("omits model rows entirely when model_scoped is empty", async () => {
    mockUsage(claudeReport({ modelScoped: [] }));
    render(<UsagePage />);

    await screen.findByTestId("usage-sub-claude-live-5h");
    expect(
      screen.queryByTestId("usage-sub-claude-live-model-0")
    ).not.toBeInTheDocument();
  });

  it("shows extra usage credits when the account has them enabled", async () => {
    mockUsage(report([CLAUDE_LIVE_SUB]));
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-claude-extra")).toHaveTextContent(
      "Extra usage: 12.5 / 100 credits · 12.5%"
    );
  });

  it("hides the extra usage line when the account has it disabled", async () => {
    mockUsage(
      claudeReport({
        extraUsage: {
          isEnabled: false,
          monthlyLimit: null,
          usedCredits: null,
          utilizationPercent: null,
        },
      })
    );
    render(<UsagePage />);

    await screen.findByTestId("usage-sub-claude-live-5h");
    expect(screen.queryByTestId("usage-sub-claude-extra")).not.toBeInTheDocument();
  });

  it("em-dashes unknown extra-usage numbers rather than zeroing them", async () => {
    mockUsage(
      claudeReport({
        extraUsage: {
          isEnabled: true,
          monthlyLimit: null,
          usedCredits: null,
          utilizationPercent: null,
        },
      })
    );
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-claude-extra")).toHaveTextContent(
      "Extra usage: — / — credits · —%"
    );
  });

  it("dates the poll from the CLI read, naming the source", async () => {
    mockUsage(report([CLAUDE_LIVE_SUB]));
    render(<UsagePage />);

    const captured = await screen.findByTestId("usage-sub-claude-captured");
    expect(captured).toHaveTextContent("Live · polled 2m ago · claude CLI");
    expect(captured.className).not.toContain("text-priority-yellow");
  });

  it("demotes the Arij meter under an explicit this-machine-only label", async () => {
    mockUsage(report([CLAUDE_LIVE_SUB]));
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-claude-metered-sub")
    ).toHaveTextContent("ARIJ-METERED · THIS MACHINE ONLY");
    expect(screen.getByTestId("usage-sub-claude-code-5h")).toHaveTextContent(
      "1 session · 1.0M tokens · $1.20"
    );
    expect(screen.getByTestId("usage-sub-claude-code-7d")).toHaveTextContent(
      "5 sessions · 40.3M tokens · $30.00"
    );
    expect(
      screen.getByTestId("usage-sub-claude-budget-readout")
    ).toHaveTextContent("$30.00 / $50.00");
    expect(screen.getByTestId("usage-sub-claude-budget-fill")).toHaveStyle({
      width: "60%",
    });

    // The section label replaces the standalone disclaimer sentence, and the
    // fallback notice must not appear on a live card.
    expect(
      screen.queryByTestId("usage-sub-claude-disclaimer")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("usage-sub-claude-live-fallback")
    ).not.toBeInTheDocument();
  });

  it("keeps the demoted budget gauge honest when the budget is blown", async () => {
    mockUsage(
      report([
        {
          ...CLAUDE_LIVE_SUB,
          metered: {
            ...CLAUDE_METERED,
            last7d: {
              sessions: 9,
              inputTokens: 80_000_000,
              outputTokens: 600_000,
              costUsd: 70,
            },
            budgetUsedPercent: 140,
          },
        },
      ])
    );
    render(<UsagePage />);

    const readout = await screen.findByTestId("usage-sub-claude-budget-readout");
    expect(readout).toHaveTextContent("$70.00 / $50.00");
    expect(readout.className).toContain("text-destructive");
    expect(screen.getByTestId("usage-sub-claude-budget-fill")).toHaveStyle({
      width: "100%",
    });
  });
});

describe("Usage page — claude live quota unavailable", () => {
  it("says the live read failed and falls back to the metered body", async () => {
    mockUsage(report([CLAUDE_FALLBACK_SUB]));
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-claude-live-fallback")
    ).toHaveTextContent("Live quota unavailable — showing metered data.");
    expect(
      screen.getByTestId("usage-sub-claude-code-source")
    ).toHaveTextContent("Metered via Arij");
    expect(screen.getByTestId("usage-sub-claude-disclaimer")).toHaveTextContent(
      "Sessions recorded by Arij only — not the account's full quota."
    );
    expect(screen.getByTestId("usage-sub-claude-code-5h")).toHaveTextContent(
      "1 session · 1.0M tokens · $1.20"
    );
  });

  it("renders no account gauges at all when the live read failed", async () => {
    mockUsage(report([CLAUDE_FALLBACK_SUB]));
    render(<UsagePage />);

    await screen.findByTestId("usage-sub-claude-code");
    expect(
      screen.queryByTestId("usage-sub-claude-live-5h")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("usage-sub-claude-live-7d")
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-sub-claude-extra")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("usage-sub-claude-captured")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("usage-sub-claude-metered-sub")
    ).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Codex — live                                                               */
/* -------------------------------------------------------------------------- */

describe("Usage page — codex live quota", () => {
  it("renders every delivered bucket, naming it as the provider does", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    const primary = await screen.findByTestId("usage-sub-codex-bucket-codex");
    // limitName is null here, so the raw limitId stands in — nothing invented.
    expect(primary).toHaveTextContent("CODEX · WEEKLY");
    expect(
      screen.getByTestId("usage-sub-codex-bucket-codex-readout")
    ).toHaveTextContent("6%");
    expect(screen.getByTestId("usage-sub-codex-bucket-codex-fill")).toHaveStyle({
      width: "6%",
    });

    const spark = screen.getByTestId(
      "usage-sub-codex-bucket-codex_bengalfox"
    );
    expect(spark).toHaveTextContent("GPT-5.3-CODEX-SPARK · WEEKLY");
    expect(
      screen.getByTestId("usage-sub-codex-bucket-codex_bengalfox-readout")
    ).toHaveTextContent("2%");
  });

  it("counts each bucket down from its unix-seconds reset", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-codex-bucket-codex-reset")
    ).toHaveTextContent("resets in 3d 0h");
    expect(
      screen.getByTestId("usage-sub-codex-bucket-codex_bengalfox-reset")
    ).toHaveTextContent("resets in 3d 0h");
  });

  it("renders no secondary gauge when the provider sends secondary: null", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    await screen.findByTestId("usage-sub-codex-bucket-codex");
    expect(
      screen.queryByTestId("usage-sub-codex-bucket-codex-secondary")
    ).not.toBeInTheDocument();
  });

  it("renders the second window when the account is on a dual-window plan", async () => {
    const dual: CodexQuotaBucket = {
      limitId: "codex",
      limitName: null,
      usedPercent: 1,
      windowDurationMins: 300,
      resetsAtUnix: NOW_SEC + 3600,
      secondary: {
        usedPercent: 9,
        windowDurationMins: 10080,
        resetsAtUnix: NOW_SEC + 2 * 86400,
      },
    };
    mockUsage(report([codexSubWith({ buckets: [dual] })]));
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-codex-bucket-codex")).toHaveTextContent(
      "CODEX · 5H WINDOW"
    );
    expect(
      screen.getByTestId("usage-sub-codex-bucket-codex-reset")
    ).toHaveTextContent("resets in 1h 0m");

    const secondary = screen.getByTestId(
      "usage-sub-codex-bucket-codex-secondary"
    );
    expect(secondary).toHaveTextContent("CODEX · WEEKLY");
    expect(
      screen.getByTestId("usage-sub-codex-bucket-codex-secondary-readout")
    ).toHaveTextContent("9%");
    expect(
      screen.getByTestId("usage-sub-codex-bucket-codex-secondary-reset")
    ).toHaveTextContent("resets in 2d 0h");
  });

  it("labels an unknown window neutrally instead of assuming one", async () => {
    mockUsage(
      codexReport({
        buckets: [
          {
            limitId: "codex",
            limitName: null,
            usedPercent: 6,
            windowDurationMins: null,
            resetsAtUnix: null,
            secondary: null,
          },
        ],
      })
    );
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-codex-bucket-codex")).toHaveTextContent(
      "CODEX · WINDOW"
    );
    expect(
      screen.getByTestId("usage-sub-codex-bucket-codex-reset")
    ).toHaveTextContent("reset time unknown");
  });

  it("hides the credits line when the account holds none", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    await screen.findByTestId("usage-sub-codex-bucket-codex");
    expect(screen.queryByTestId("usage-sub-codex-credits")).not.toBeInTheDocument();
  });

  it("shows the credits balance the provider reported", async () => {
    mockUsage(
      codexReport({ credits: { hasCredits: true, unlimited: false, balance: "42" } })
    );
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-codex-credits")).toHaveTextContent(
      "Credits: 42"
    );
  });

  it("shows unlimited credits without inventing a balance", async () => {
    mockUsage(
      codexReport({ credits: { hasCredits: true, unlimited: true, balance: null } })
    );
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-codex-credits")).toHaveTextContent(
      "Credits: unlimited"
    );
  });

  it("dates the poll from the app-server read", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-codex-captured")).toHaveTextContent(
      "Live · polled 2m ago · codex app-server"
    );
  });
});

describe("Usage page — codex provider history strip", () => {
  it("keeps the all-devices history inside the codex card, apart from Arij's strip", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    const card = await screen.findByTestId("usage-sub-codex");
    const label = within(card).getByTestId("usage-sub-codex-history-label");
    expect(label).toHaveTextContent("ALL DEVICES · PROVIDER-REPORTED");
    expect(within(card).getByTestId("usage-sub-codex-history")).toBeInTheDocument();

    // Arij's own 30-day strip lives outside the card and stays Arij-metered.
    const arijStrip = screen.getByTestId("usage-day-strip");
    expect(card.contains(arijStrip)).toBe(false);
    expect(arijStrip.children).toHaveLength(30);
  });

  it("renders exactly the delivered days, sparse, without zero-filling", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    const strip = await screen.findByTestId("usage-sub-codex-history");
    expect(strip.children).toHaveLength(4);
    expect(
      screen.getByTestId("usage-sub-codex-history-2026-08-15")
    ).toHaveAttribute("title", "2026-08-15 · 26.8M tokens");
    // A gap in the provider's data is a gap, not a fabricated zero bar.
    expect(
      screen.queryByTestId("usage-sub-codex-history-2026-08-14")
    ).not.toBeInTheDocument();
  });

  it("scales the bars to the busiest delivered day", async () => {
    mockUsage(
      codexReport({
        dailyUsage: [
          { date: "2026-08-15", tokens: 100 },
          { date: "2026-08-16", tokens: 50 },
          { date: "2026-08-17", tokens: 25 },
          { date: "2026-08-18", tokens: 0 },
        ],
      })
    );
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-codex-history-2026-08-15")
    ).toHaveStyle({ height: "100%", opacity: "0.75" });
    expect(screen.getByTestId("usage-sub-codex-history-2026-08-16")).toHaveStyle({
      height: "50%",
    });
    expect(screen.getByTestId("usage-sub-codex-history-2026-08-17")).toHaveStyle({
      height: "25%",
    });
    expect(screen.getByTestId("usage-sub-codex-history-2026-08-18")).toHaveStyle({
      height: "0%",
      opacity: "0.25",
    });
  });

  it("caps the strip at the last 30 delivered days", async () => {
    mockUsage(
      codexReport({
        dailyUsage: Array.from({ length: 45 }, (_, i) => ({
          date: `2026-07-${String(i + 1).padStart(2, "0")}`,
          tokens: 1_000 + i,
        })),
      })
    );
    render(<UsagePage />);

    const strip = await screen.findByTestId("usage-sub-codex-history");
    expect(strip.children).toHaveLength(30);
    expect(
      screen.queryByTestId("usage-sub-codex-history-2026-07-15")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("usage-sub-codex-history-2026-07-16")
    ).toBeInTheDocument();
  });

  it("reports the lifetime total the provider sent", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-codex-lifetime")).toHaveTextContent(
      "Lifetime: 1383.5M tokens"
    );
  });

  it("drops the whole strip when the provider sent no history", async () => {
    mockUsage(codexReport({ dailyUsage: [], lifetimeTokens: null }));
    render(<UsagePage />);

    await screen.findByTestId("usage-sub-codex-bucket-codex");
    expect(
      screen.queryByTestId("usage-sub-codex-history-label")
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-sub-codex-history")).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-sub-codex-lifetime")).not.toBeInTheDocument();
  });

  it("keeps the lifetime total when only the daily buckets are missing", async () => {
    mockUsage(codexReport({ dailyUsage: [] }));
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-codex-lifetime")).toHaveTextContent(
      "Lifetime: 1383.5M tokens"
    );
    expect(screen.queryByTestId("usage-sub-codex-history")).not.toBeInTheDocument();
  });

  it("carries no percentages — the history is tokens, not a quota", async () => {
    mockUsage(report([CODEX_LIVE_SUB]));
    render(<UsagePage />);

    const label = await screen.findByTestId("usage-sub-codex-history-label");
    const section = label.parentElement!;
    expect(section.textContent).not.toContain("%");
  });
});

describe("Usage page — codex live quota unavailable", () => {
  it("says the live read failed and replays the last rollout snapshot", async () => {
    mockUsage(report([CODEX_SNAPSHOT_SUB]));
    render(<UsagePage />);

    expect(
      await screen.findByTestId("usage-sub-codex-live-fallback")
    ).toHaveTextContent("Live quota unavailable — showing last snapshot.");
    expect(
      screen.getByTestId("usage-sub-codex-primary-readout")
    ).toHaveTextContent("6%");
    expect(
      screen.getByTestId("usage-sub-codex-primary-reset")
    ).toHaveTextContent("resets in 4h 12m");
    expect(screen.getByTestId("usage-sub-codex-captured")).toHaveTextContent(
      "Captured 2h ago · ~/.codex/sessions"
    );
  });

  it("renders no live buckets or provider history when the live read failed", async () => {
    mockUsage(report([CODEX_SNAPSHOT_SUB]));
    render(<UsagePage />);

    await screen.findByTestId("usage-sub-codex");
    expect(
      screen.queryByTestId("usage-sub-codex-bucket-codex")
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-sub-codex-history")).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-sub-codex-lifetime")).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-sub-codex-credits")).not.toBeInTheDocument();
  });

  it("keeps the no-snapshot empty state free of any fallback chatter", async () => {
    mockUsage(report([CODEX_EMPTY_SUB]));
    render(<UsagePage />);

    expect(await screen.findByTestId("usage-sub-codex-empty")).toHaveTextContent(
      "No provider snapshot found."
    );
    expect(
      screen.queryByTestId("usage-sub-codex-live-fallback")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("usage-sub-codex-primary")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("usage-sub-codex-captured")
    ).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Both cards together                                                        */
/* -------------------------------------------------------------------------- */

describe("Usage page — mixed live and fallback cards", () => {
  it("renders one card per provider, each at its own source of truth", async () => {
    mockUsage(report([CODEX_LIVE_SUB, CLAUDE_FALLBACK_SUB]));
    render(<UsagePage />);

    const codexCard = await screen.findByTestId("usage-sub-codex");
    expect(
      within(codexCard).getByTestId("usage-sub-codex-source")
    ).toHaveTextContent("Provider-reported");
    expect(
      within(codexCard).getByTestId("usage-sub-codex-bucket-codex")
    ).toBeInTheDocument();

    const claudeCard = screen.getByTestId("usage-sub-claude-code");
    expect(
      within(claudeCard).getByTestId("usage-sub-claude-code-source")
    ).toHaveTextContent("Metered via Arij");
    expect(
      within(claudeCard).getByTestId("usage-sub-claude-live-fallback")
    ).toBeInTheDocument();
  });

  it("renders both live cards side by side without leaking testids across them", async () => {
    mockUsage(report([CODEX_LIVE_SUB, CLAUDE_LIVE_SUB]));
    render(<UsagePage />);

    const codexCard = await screen.findByTestId("usage-sub-codex");
    const claudeCard = screen.getByTestId("usage-sub-claude-code");

    expect(
      within(claudeCard).getByTestId("usage-sub-claude-live-5h")
    ).toBeInTheDocument();
    expect(
      within(codexCard).queryByTestId("usage-sub-claude-live-5h")
    ).not.toBeInTheDocument();
    expect(
      within(codexCard).getByTestId("usage-sub-codex-history")
    ).toBeInTheDocument();
    expect(
      within(claudeCard).queryByTestId("usage-sub-codex-history")
    ).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function claudeReport(
  patch: Partial<NonNullable<SubscriptionStatus["claudeLive"]>>
): UsageReport {
  return report([claudeSubWith(patch)]);
}

function codexReport(
  patch: Partial<NonNullable<SubscriptionStatus["codexLive"]>>
): UsageReport {
  return report([codexSubWith(patch)]);
}
