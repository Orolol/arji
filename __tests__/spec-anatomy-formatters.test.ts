/**
 * The pure helpers behind frame 8b: token/word formatting, the French
 * relative save time, and the eight-keys-onto-six-segments folding that the
 * prompt-anatomy route and the anatomy band both depend on.
 */
import { describe, expect, it } from "vitest";

import {
  EM_DASH,
  countWords,
  formatCount,
  formatFrenchRelative,
  formatSaveState,
  formatTokens,
} from "@/components/spec/spec-format";
import {
  PROMPT_ANATOMY_ORDER,
  estimatePromptTokensBySections,
  toPromptAnatomySegments,
  type PromptTokenBreakdown,
} from "@/lib/tokens/estimator";

function breakdown(over: Partial<PromptTokenBreakdown> = {}): PromptTokenBreakdown {
  return {
    spec: 0,
    memory: 0,
    ticket: 0,
    comments: 0,
    findings: 0,
    documents: 0,
    system: 0,
    other: 0,
    ...over,
  };
}

describe("formatTokens", () => {
  it("prints raw counts below a thousand", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0)).toBe("0");
  });

  it("prints one decimal of thousands and strips a trailing .0", () => {
    expect(formatTokens(1100)).toBe("1.1k");
    expect(formatTokens(14200)).toBe("14.2k");
    expect(formatTokens(10000)).toBe("10k");
  });

  it("renders an em dash — never a zero — for an unknown count", () => {
    expect(formatTokens(null)).toBe(EM_DASH);
    expect(formatTokens(undefined)).toBe(EM_DASH);
    expect(formatTokens(Number.NaN)).toBe(EM_DASH);
    expect(formatTokens(null)).not.toBe("0k");
  });
});

describe("formatCount", () => {
  it("groups thousands with a PLAIN space, not a narrow no-break space", () => {
    expect(formatCount(1240)).toBe("1 240");
    expect(formatCount(1240)).toContain(" ");
    expect(formatCount(1240)).not.toContain(" ");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1 234 567");
  });
});

describe("formatFrenchRelative", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("never says 'il y a 0 s'", () => {
    expect(formatFrenchRelative(ago(4_000), now)).toBe("à l'instant");
    expect(formatFrenchRelative(ago(0), now)).toBe("à l'instant");
  });

  it("counts seconds, minutes, hours and days", () => {
    expect(formatFrenchRelative(ago(12_000), now)).toBe("il y a 12 s");
    expect(formatFrenchRelative(ago(90_000), now)).toBe("il y a 1 min");
    expect(formatFrenchRelative(ago(3 * 3_600_000), now)).toBe("il y a 3 h");
    expect(formatFrenchRelative(ago(50 * 3_600_000), now)).toBe("il y a 2 j");
  });

  it("renders an em dash for a missing or unparsable timestamp", () => {
    expect(formatFrenchRelative(null, now)).toBe(EM_DASH);
    expect(formatFrenchRelative("not-a-date", now)).toBe(EM_DASH);
  });
});

describe("formatSaveState", () => {
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  it("reports unsaved edits", () => {
    expect(formatSaveState({ dirty: true, savedAt: null }, now)).toBe(
      "non sauvegardé",
    );
  });

  it("reports an em dash when nothing was ever saved", () => {
    expect(formatSaveState({ dirty: false, savedAt: null }, now)).toBe(EM_DASH);
  });

  it("reports the French relative time when clean", () => {
    const savedAt = new Date(now - 12_000).toISOString();
    expect(formatSaveState({ dirty: false, savedAt }, now)).toBe(
      "sauvegardé il y a 12 s",
    );
  });
});

describe("countWords", () => {
  it("is zero only for genuinely empty text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n ")).toBe(0);
    expect(countWords("une spec  de   projet")).toBe(4);
  });
});

describe("toPromptAnatomySegments", () => {
  it("folds ticket + comments + findings into one TICKET segment", () => {
    const segments = toPromptAnatomySegments(
      breakdown({ ticket: 100, comments: 40, findings: 60 }),
    );
    expect(segments.ticket).toBe(200);
  });

  it("folds `other` into SYSTEM rather than inventing a seventh colour", () => {
    const segments = toPromptAnatomySegments(
      breakdown({ system: 300, other: 200 }),
    );
    expect(segments.system).toBe(500);
  });

  it("takes PERSONA from the caller, since a stored breakdown never has one", () => {
    expect(toPromptAnatomySegments(breakdown(), 480).persona).toBe(480);
    expect(toPromptAnatomySegments(breakdown(), 0).persona).toBe(0);
  });

  it("falls back to an explicitly estimated persona when none is passed", () => {
    const withPersona = { ...breakdown(), persona: 120 };
    expect(toPromptAnatomySegments(withPersona).persona).toBe(120);
    expect(toPromptAnatomySegments(withPersona, 0).persona).toBe(0);
  });

  it("maps documents onto DOCS and keeps spec/memory untouched", () => {
    const segments = toPromptAnatomySegments(
      breakdown({ documents: 90, spec: 3100, memory: 1100 }),
    );
    expect(segments.docs).toBe(90);
    expect(segments.spec).toBe(3100);
    expect(segments.memory).toBe(1100);
  });

  it("emits exactly the six drawn segments, in paint order", () => {
    const segments = toPromptAnatomySegments(breakdown());
    expect(Object.keys(segments).sort()).toEqual([...PROMPT_ANATOMY_ORDER].sort());
    expect(PROMPT_ANATOMY_ORDER).toEqual([
      "system",
      "persona",
      "spec",
      "memory",
      "ticket",
      "docs",
    ]);
  });
});

describe("estimatePromptTokensBySections — the persona key stays optional", () => {
  it("keeps the eight-key wire shape when no persona is supplied", () => {
    const result = estimatePromptTokensBySections({ spec: "hello" });
    expect(Object.values(result.breakdown)).toHaveLength(8);
    expect("persona" in result.breakdown).toBe(false);
  });

  it("adds the ninth key only when a persona text is supplied", () => {
    const result = estimatePromptTokensBySections({
      spec: "hello",
      persona: "You are a careful reviewer.",
    });
    expect(Object.values(result.breakdown)).toHaveLength(9);
    expect(result.breakdown.persona).toBeGreaterThan(0);
  });

  it("does not add the key for an empty persona string", () => {
    const result = estimatePromptTokensBySections({ spec: "hello", persona: "" });
    expect(Object.values(result.breakdown)).toHaveLength(8);
  });
});
