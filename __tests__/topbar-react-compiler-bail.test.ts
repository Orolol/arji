// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";

/**
 * `TopBar` is mounted once by `app/layout.tsx`, so it renders on every route.
 * `react-hooks/preserve-manual-memoization` reported "Compilation Skipped" on
 * `openPaletteResult`: the callback's inferred dependency (`setPaletteOpen`)
 * was missing from its declared `[router]`, and the React Compiler responded by
 * giving up on the whole component. The fix declares the setter.
 *
 * The catch is that the compiler bails *silently*. A component it has stopped
 * compiling reports nothing at all — indistinguishable from a clean one. So
 * "TopBar lints clean" is not by itself evidence that the violation is gone; a
 * `"use no memo"` directive, a disable comment or a suppressions entry would
 * produce the same silence while leaving the component uncompiled.
 *
 * This file therefore asserts the invariant *and* the mutation control that
 * gives it meaning: put the buggy dependency list back, and the bail must
 * reappear. Only a component the compiler still analyses can fail that way, so
 * the control is what separates "fixed" from "masked".
 *
 * `npm run lint` covers the same rule, but CI runs the Vitest suite; without
 * this the regression can return unobserved.
 */

const TOP_BAR_PATH = path.join(process.cwd(), "components/piscine/TopBar.tsx");

/**
 * The declared dependency list of `openPaletteResult`, and the form that made
 * the compiler bail. Both are anchors: if `openPaletteResult` is ever
 * rewritten — dropping the manual `useCallback` is the other legitimate fix —
 * the anchor test below fails loudly rather than letting the control silently
 * mutate nothing and pass.
 */
const FIXED_DEPS = "[router, setPaletteOpen],";
const BUGGY_DEPS = "[router],";

const BAIL_RULE = "react-hooks/preserve-manual-memoization";

let source: string;
let eslint: ESLint;

/**
 * ESLint 9 applies `eslint-suppressions.json` in its CLI layer, not in the
 * `ESLint` class, so these messages are unsuppressed — which is what we want.
 * Baselining this violation would keep `npm run lint` green while the component
 * stayed uncompiled, and that is the failure mode this test exists to catch.
 */
function lint(text: string) {
  return eslint
    .lintText(text, { filePath: TOP_BAR_PATH })
    .then(([result]) => result.messages);
}

beforeAll(() => {
  source = readFileSync(TOP_BAR_PATH, "utf8");
  eslint = new ESLint({ cwd: process.cwd() });
});

describe("TopBar and the React Compiler", () => {
  it("lints TopBar with the bail rule at error severity", async () => {
    const config = await eslint.calculateConfigForFile(TOP_BAR_PATH);

    // Turning the rule off would silence every other assertion here without
    // failing any of them.
    expect(config.rules?.[BAIL_RULE]?.[0]).toBe(2);
  });

  it("still carries the dependency list the mutation control rewrites", () => {
    expect(source.split(FIXED_DEPS).length - 1).toBe(1);
  });

  it("draws no React Compiler error, so the component is still compiled", async () => {
    const errors = (await lint(source)).filter(
      (message) => message.severity === 2 && message.ruleId?.startsWith("react-hooks/"),
    );

    // Reported with the messages attached: a bail names the callback it gave
    // up on, which is the whole diagnosis.
    expect(errors.map((message) => `${message.ruleId}: ${message.message}`)).toEqual([]);
  });

  it("reports the bail again when the declared dependency is removed", async () => {
    const mutated = source.replace(FIXED_DEPS, BUGGY_DEPS);
    expect(mutated).not.toBe(source);

    const bails = (await lint(mutated)).filter(
      (message) => message.ruleId === BAIL_RULE && message.severity === 2,
    );

    expect(bails).toHaveLength(1);
    expect(bails[0].message).toContain("Compilation Skipped");
  });
});
