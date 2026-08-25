/**
 * Dreaming — the pure half of the collector (lib/workflow/dreaming-digest.ts):
 * the collection window, the per-session rendering, and the fair-truncation
 * budget that keeps the digest under its hard cap.
 *
 * No database here on purpose: these are the rules the acceptance criteria
 * name ("fenêtre depuis le dernier dream, plafonnée", "budget de taille dur
 * avec troncature équitable"), and they are worth pinning without a schema.
 * The DB-backed selection is covered by dreaming-collector.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  allocateFairBudgets,
  assembleDreamDigest,
  extractReviewVerdict,
  parseTimestampMs,
  renderSessionDigest,
  resolveDreamWindow,
  tailText,
  truncateText,
  validateDreamedMemoryStructure,
  type DreamSessionDigest,
} from "@/lib/workflow/dreaming-digest";
import {
  DREAMING_MEMORY_SECTIONS,
  DREAM_WINDOW_DAYS,
} from "@/lib/workflow/dreaming-constants";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<DreamSessionDigest> = {}): DreamSessionDigest {
  return {
    sessionId: "sess-1",
    at: "2026-08-24T10:00:00.000Z",
    ticketLabel: "E-proj-003: Checkout flow",
    agentType: "ticket_build",
    provider: "claude-code",
    model: "opus",
    status: "completed",
    outcome: "answered",
    durationMs: 125_000,
    costUsd: 1.5,
    error: null,
    reviewVerdict: null,
    findings: [],
    forensic: null,
    finalText: null,
    ...overrides,
  };
}

describe("resolveDreamWindow", () => {
  it("opens at the last dream's collection cutoff when it is inside the age cap", () => {
    const lastCutoffAt = new Date(NOW.getTime() - 2 * DAY_MS).toISOString();
    const window = resolveDreamWindow({ lastCutoffAt, now: NOW });
    expect(window.sinceIso).toBe(lastCutoffAt);
    expect(window.boundedByLastCutoff).toBe(true);
  });

  it("falls back to the age cap when there is no previous dream", () => {
    const window = resolveDreamWindow({ lastCutoffAt: null, now: NOW });
    expect(window.boundedByLastCutoff).toBe(false);
    expect(window.sinceIso).toBe(
      new Date(NOW.getTime() - DREAM_WINDOW_DAYS * DAY_MS).toISOString()
    );
  });

  it("never reaches further back than the age cap, however old the last cutoff", () => {
    const ancient = new Date(NOW.getTime() - 90 * DAY_MS).toISOString();
    const window = resolveDreamWindow({ lastCutoffAt: ancient, now: NOW });
    expect(window.boundedByLastCutoff).toBe(false);
    expect(Date.parse(window.sinceIso)).toBe(
      NOW.getTime() - DREAM_WINDOW_DAYS * DAY_MS
    );
  });

  it("treats an unparseable cutoff as no previous dream at all", () => {
    const window = resolveDreamWindow({ lastCutoffAt: "not-a-date", now: NOW });
    expect(window.boundedByLastCutoff).toBe(false);
    expect(Date.parse(window.sinceIso)).toBe(
      NOW.getTime() - DREAM_WINDOW_DAYS * DAY_MS
    );
  });

  it("honours a custom window length", () => {
    const window = resolveDreamWindow({
      lastCutoffAt: null,
      now: NOW,
      windowDays: 3,
    });
    expect(Date.parse(window.sinceIso)).toBe(NOW.getTime() - 3 * DAY_MS);
  });
});

/**
 * Two timestamp shapes coexist in these columns: ISO strings the app writes,
 * and SQLite CURRENT_TIMESTAMP defaults. `Date.parse` reads the second as
 * LOCAL time while SQLite emits UTC, so a default-stamped row would drift by
 * the host's offset and could land on the wrong side of a dream's cutoff.
 */
describe("parseTimestampMs", () => {
  it("reads a SQLite CURRENT_TIMESTAMP string as UTC", () => {
    expect(parseTimestampMs("2026-08-25 12:00:00")).toBe(
      Date.parse("2026-08-25T12:00:00.000Z")
    );
    expect(parseTimestampMs("2026-08-25 12:00:00.500")).toBe(
      Date.parse("2026-08-25T12:00:00.500Z")
    );
  });

  it("agrees with the ISO form for the same instant", () => {
    expect(parseTimestampMs("2026-08-25 12:00:00")).toBe(
      parseTimestampMs("2026-08-25T12:00:00.000Z")
    );
  });

  it("leaves explicit offsets alone", () => {
    expect(parseTimestampMs("2026-08-25T14:00:00+02:00")).toBe(
      Date.parse("2026-08-25T12:00:00.000Z")
    );
  });

  it("is null for anything undateable", () => {
    expect(parseTimestampMs(null)).toBeNull();
    expect(parseTimestampMs(undefined)).toBeNull();
    expect(parseTimestampMs("")).toBeNull();
    expect(parseTimestampMs("not-a-date")).toBeNull();
  });
});

/**
 * The prompt IMPOSES four sections, but a prompt is not a guarantee — and even
 * a compliant answer can arrive malformed, because `saveProjectMemory`
 * truncates at the cap and can lop the last section off a long response.
 * Storing either would put a broken document into every future prompt AND mark
 * the digest window as learned.
 */
describe("validateDreamedMemoryStructure", () => {
  const wellFormed = DREAMING_MEMORY_SECTIONS.map(
    (title) => `## ${title}\n\n- a rule`
  ).join("\n\n");

  it("accepts the four sections in order", () => {
    expect(validateDreamedMemoryStructure(wellFormed)).toEqual({
      valid: true,
      reason: "",
    });
  });

  it("rejects a document missing a section", () => {
    const withoutLast = DREAMING_MEMORY_SECTIONS.slice(0, 3)
      .map((title) => `## ${title}\n\n- a rule`)
      .join("\n\n");
    const result = validateDreamedMemoryStructure(withoutLast);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(DREAMING_MEMORY_SECTIONS[3]);
  });

  it("rejects sections in the wrong order", () => {
    const shuffled = [
      DREAMING_MEMORY_SECTIONS[1],
      DREAMING_MEMORY_SECTIONS[0],
      DREAMING_MEMORY_SECTIONS[2],
      DREAMING_MEMORY_SECTIONS[3],
    ]
      .map((title) => `## ${title}\n\n- a rule`)
      .join("\n\n");
    const result = validateDreamedMemoryStructure(shuffled);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("out of order");
  });

  it("rejects a duplicated section", () => {
    const result = validateDreamedMemoryStructure(
      `${wellFormed}\n\n## ${DREAMING_MEMORY_SECTIONS[0]}\n\n- again`
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("duplicated");
  });

  /**
   * The truncation case, reproduced exactly as the cap would produce it: a
   * long compliant document cut mid-way, losing its tail sections.
   */
  it("rejects a document the cap truncated mid-way", () => {
    const long = DREAMING_MEMORY_SECTIONS.map(
      (title) => `## ${title}\n\n${"- a long rule\n".repeat(200)}`
    ).join("\n");
    expect(validateDreamedMemoryStructure(long).valid).toBe(true);

    const truncated = long.slice(0, 2_000);
    const result = validateDreamedMemoryStructure(truncated);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("missing required section");
  });

  it("rejects prose with no sections at all", () => {
    const result = validateDreamedMemoryStructure(
      "Here is my summary of the sessions I read."
    );
    expect(result.valid).toBe(false);
    // Caught by the preamble rule — with no headings at all, the whole answer
    // IS content before the first section.
    expect(result.reason).toContain("content before the first section");
  });

  /**
   * The prompt says EXACTLY these four sections. A bonus heading is a document
   * that did not follow the contract, and the memory is read by every future
   * prompt — so the structure is enforced as written rather than approximated.
   */
  it("rejects an EXTRA section alongside the four", () => {
    const result = validateDreamedMemoryStructure(
      `${wellFormed}\n\n## Open questions\n\n- x`
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Open questions");
  });

  /**
   * The "Here is the rewritten memory:" failure mode. The response is written
   * VERBATIM into the document, so a conversational preamble becomes the first
   * thing every future prompt reads.
   */
  it("rejects prose before the first section", () => {
    const result = validateDreamedMemoryStructure(
      `Here is the rewritten project memory:\n\n${wellFormed}`
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("content before the first section");
  });

  it("tolerates blank lines before the first section", () => {
    expect(validateDreamedMemoryStructure(`\n\n  \n${wellFormed}`).valid).toBe(
      true
    );
  });

  it("ignores deeper headings and bold text that only look like sections", () => {
    const withNoise = DREAMING_MEMORY_SECTIONS.map(
      (title) => `## ${title}\n\n### ${title} details\n\n**${title}**\n\n- a rule`
    ).join("\n\n");
    expect(validateDreamedMemoryStructure(withNoise).valid).toBe(true);
  });
});

describe("allocateFairBudgets", () => {
  it("gives everyone what they need when the budget is ample", () => {
    expect(allocateFairBudgets([10, 20, 30], 1000)).toEqual([10, 20, 30]);
  });

  it("splits an insufficient budget evenly when every item is oversized", () => {
    // 3 items of 100 with a budget of 30: 10 each, no favouritism.
    expect(allocateFairBudgets([100, 100, 100], 30)).toEqual([10, 10, 10]);
  });

  it("recycles the surplus of small items to the greedy ones", () => {
    // Equal shares would be 100 each; the 10-char item only needs 10, so the
    // other two split 290 instead of being capped at their own 100.
    expect(allocateFairBudgets([10, 500, 500], 300)).toEqual([10, 145, 145]);
  });

  it("never lets one huge item starve the others", () => {
    const [small, huge] = allocateFairBudgets([50, 1_000_000], 400);
    expect(small).toBe(50);
    expect(huge).toBe(350);
  });

  it("hands the integer-division remainder out deterministically", () => {
    const allocations = allocateFairBudgets([100, 100, 100], 20);
    expect(allocations).toEqual([7, 7, 6]);
    expect(allocations.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it("never allocates more than the budget", () => {
    const sizes = [5, 12, 300, 44, 900];
    for (const budget of [0, 1, 7, 60, 500, 5000]) {
      const total = allocateFairBudgets(sizes, budget).reduce((a, b) => a + b, 0);
      expect(total).toBeLessThanOrEqual(Math.max(budget, 0));
    }
  });

  it("allocates nothing for an empty list or a non-positive budget", () => {
    expect(allocateFairBudgets([], 100)).toEqual([]);
    expect(allocateFairBudgets([10, 10], 0)).toEqual([0, 0]);
    expect(allocateFairBudgets([10, 10], -5)).toEqual([0, 0]);
  });
});

describe("truncateText / tailText", () => {
  it("leaves text under the cap alone", () => {
    expect(truncateText("short", 100)).toBe("short");
    expect(tailText("short", 100)).toBe("short");
  });

  it("cuts to exactly the cap, marker included", () => {
    const cut = truncateText("x".repeat(100), 20);
    expect(cut).toHaveLength(20);
    expect(cut.endsWith("…[cut]")).toBe(true);
  });

  it("keeps the END of a final response, because that is where a conclusion is", () => {
    const text = "beginning".padEnd(200, ".") + "CONCLUSION";
    const kept = tailText(text, 30);
    expect(kept).toHaveLength(30);
    expect(kept.endsWith("CONCLUSION")).toBe(true);
  });
});

describe("extractReviewVerdict", () => {
  it("scrapes the mandated verdict line", () => {
    expect(
      extractReviewVerdict("report body\n\n**Overall Verdict: Changes Requested**")
    ).toBe("Changes Requested");
    expect(
      extractReviewVerdict("**Overall Verdict: Feature Complete**\n")
    ).toBe("Feature Complete");
  });

  it("returns null when no verdict was produced", () => {
    expect(extractReviewVerdict("no verdict here")).toBeNull();
    expect(extractReviewVerdict(null)).toBeNull();
    expect(extractReviewVerdict("")).toBeNull();
  });
});

describe("renderSessionDigest", () => {
  it("renders metadata, verdict, findings, forensic and the response tail", () => {
    const block = renderSessionDigest(
      entry({
        agentType: "review_code",
        outcome: "answered",
        reviewVerdict: "Changes Requested",
        findings: ["[critical] SQL injection in search", "[major] no tests"],
        forensic: "The build died on an OOM in the bundler.",
        finalText: "Report body ... final line.",
      })
    );

    expect(block).toContain("### E-proj-003: Checkout flow");
    expect(block).toContain("type review_code");
    expect(block).toContain("claude-code/opus");
    expect(block).toContain("outcome answered");
    expect(block).toContain("$1.50");
    expect(block).toContain("**Review verdict:** Changes Requested");
    expect(block).toContain("[critical] SQL injection in search");
    expect(block).toContain("[major] no tests");
    expect(block).toContain("**Forensic:**");
    expect(block).toContain("OOM in the bundler");
    expect(block).toContain("**Final response (tail):**");
    expect(block).toContain("final line.");
  });

  it("calls out a refused transition explicitly", () => {
    const block = renderSessionDigest(
      entry({
        outcome: "transition_refused",
        error: "Cannot move a released ticket back to in_progress",
      })
    );
    expect(block).toContain("outcome transition_refused");
    expect(block).toContain(
      "**Transition refused:** Cannot move a released ticket back to in_progress"
    );
  });

  it("labels an untied session rather than inventing a ticket", () => {
    expect(renderSessionDigest(entry({ ticketLabel: null }))).toContain(
      "### (no ticket)"
    );
  });

  it("caps a pathological field so it cannot eat the whole allocation", () => {
    const block = renderSessionDigest(
      entry({ error: "boom ".repeat(5000), outcome: "error" })
    );
    expect(block.length).toBeLessThan(1000);
  });

  it("lists at most the finding cap and says how many it hid", () => {
    const block = renderSessionDigest(
      entry({
        findings: Array.from({ length: 9 }, (_, i) => `[major] finding ${i}`),
      })
    );
    expect(block).toContain("[major] finding 5");
    expect(block).not.toContain("[major] finding 6");
    expect(block).toContain("(+3 more)");
  });
});

describe("assembleDreamDigest", () => {
  it("keeps every block when they all fit", () => {
    const result = assembleDreamDigest([entry(), entry({ sessionId: "s2" })], 10_000);
    expect(result.includedCount).toBe(2);
    expect(result.truncatedCount).toBe(0);
    expect(result.droppedCount).toBe(0);
  });

  it("enforces the hard budget", () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry({ sessionId: `s${i}`, finalText: "verbose ".repeat(400) })
    );
    const result = assembleDreamDigest(entries, 2_000);
    expect(result.text.length).toBeLessThanOrEqual(2_000);
  });

  it("truncates fairly: a short session survives intact while long ones are cut", () => {
    const short = entry({ sessionId: "short", finalText: "brief." });
    const long1 = entry({ sessionId: "long1", finalText: "x".repeat(3000) });
    const long2 = entry({ sessionId: "long2", finalText: "y".repeat(3000) });

    const shortBlockLength = renderSessionDigest(short).length;
    const result = assembleDreamDigest([short, long1, long2], 1_200);

    expect(result.includedCount).toBe(3);
    expect(result.truncatedCount).toBe(2);
    expect(result.droppedCount).toBe(0);
    // The short session is present in full — it was never asked to pay for
    // the verbose ones.
    expect(result.text).toContain("brief.");
    expect(result.text.split("\n\n")[0]).toHaveLength(shortBlockLength);
    // ...and the two long ones split what was left, evenly.
    expect(result.text).toContain("[session digest cut]");
  });

  it("reports dropped sessions instead of silently swallowing them", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      entry({ sessionId: `s${i}`, finalText: "z".repeat(500) })
    );
    const result = assembleDreamDigest(entries, 60);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.includedCount + result.droppedCount).toBe(40);
  });

  it("is empty for an empty window", () => {
    expect(assembleDreamDigest([], 1000)).toEqual({
      text: "",
      includedCount: 0,
      truncatedCount: 0,
      droppedCount: 0,
    });
  });
});
