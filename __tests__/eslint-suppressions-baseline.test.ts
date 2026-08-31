import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/**
 * `npm run lint` is an enforced CI gate, but it was landed with 40 pre-existing
 * violations recorded in `eslint-suppressions.json` (ESLint 9 bulk
 * suppressions). Every rule stays at `error`, so the gate is a true ratchet for
 * *new* code — but the baseline itself is debt, and nothing failed while it sat
 * there.
 *
 * This pins the debt at zero. A suppression re-appearing means someone
 * baselined a fresh violation instead of fixing it, which is exactly the
 * regression the ratchet cannot catch on its own.
 *
 * Note the file is deliberately kept (as `{}`) rather than deleted: `npm run
 * lint` reads it, and its absence would silently turn bulk suppressions off.
 */
type SuppressionFile = Record<string, Record<string, { count: number }>>;

const SUPPRESSIONS_PATH = path.join(process.cwd(), "eslint-suppressions.json");

function readSuppressions(): SuppressionFile {
  return JSON.parse(readFileSync(SUPPRESSIONS_PATH, "utf8")) as SuppressionFile;
}

describe("eslint suppressions baseline", () => {
  it("still exists, so `npm run lint` keeps reading a suppressions file", () => {
    expect(() => readSuppressions()).not.toThrow();
  });

  it("records no suppressed files", () => {
    const suppressions = readSuppressions();
    expect(Object.keys(suppressions)).toEqual([]);
  });

  it("records no suppressed violations for any rule", () => {
    const suppressions = readSuppressions();

    const perRule = new Map<string, number>();
    for (const rules of Object.values(suppressions)) {
      for (const [ruleId, { count }] of Object.entries(rules)) {
        perRule.set(ruleId, (perRule.get(ruleId) ?? 0) + count);
      }
    }

    // Named per rule so a re-baselined violation says which rule regressed.
    expect(Object.fromEntries(perRule)).toEqual({});
  });
});
