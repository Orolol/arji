// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";

/**
 * `TopBar` is mounted once by `app/layout.tsx`, so it renders on every route.
 * `react-hooks/preserve-manual-memoization` reported "Compilation Skipped" on
 * `openPaletteResult`, and declaring the missing `setPaletteOpen` dependency
 * silenced it — without reopening anything.
 *
 * The silence was the bug. The React Compiler's rules only recognise a hook
 * called by its bare name: in a file written `import * as React from "react"`,
 * `React.useEffect(...)` is not a hook as far as they are concerned, so
 * everything inside it goes unread. TopBar called all 22 of its hooks that way.
 * A file can therefore sit at zero errors while the compiler never looks at it,
 * which is exactly what "clean" meant here — four real
 * `react-hooks/set-state-in-effect` violations were hidden behind it, one of
 * them the palette reset three lines under the callback that was reported.
 *
 * So a lint run of TopBar proves nothing on its own, and this file does not
 * rely on one. It asserts that the analysis is OPEN, by mutation: inject a
 * violation and require the rule to report it. A component the rules never
 * enter is silent, so an error under mutation is the only thing that tells a
 * fixed component from an unread one.
 *
 * WHAT THE PROBES CATCH, measured on eslint-plugin-react-hooks 7.0.1 against
 * this file (both probes report 1 error unmasked):
 *
 *   namespace form (`React.useEffect`)  effect probe silent, bail probe still
 *                                       reports — the effect probe is the
 *                                       load-bearing one, and the source
 *                                       assertion below names the mask outright
 *   blanket `eslint-disable` of these
 *   rules                               both probes silent
 *   `"use no memo"` directive           BOTH PROBES STILL REPORT
 *
 * That last row is why this file cannot claim to prove compilation. The
 * directive opts the component out of the compiler's OUTPUT, not out of its
 * lint rules, so no diagnostic here can see it and it is asserted on the source
 * instead. What these probes establish is that the rules read TopBar — which is
 * the gate that actually exists today, `next.config.ts` not enabling the
 * compiler at build time. Proving successful transformation would mean reading
 * compiler output, which nothing in this repo does.
 *
 * `npm run lint` covers the same rules, but CI runs the Vitest suite. The
 * suppressions baseline is applied in ESLint's CLI layer (`lib/cli.js`) and not
 * by the `ESLint` class used here, so baselining the violation would keep
 * `npm run lint` green while leaving every assertion below untouched.
 */

const TOP_BAR_PATH = path.join(process.cwd(), "components/piscine/TopBar.tsx");

/**
 * Anchors the mutation controls rewrite. Each is asserted to occur exactly
 * once before it is used, so a refactor that moves the code fails here loudly
 * rather than leaving a control that silently mutates nothing and passes.
 */
const CALLBACK_ANCHOR = "  const openPaletteResult = useCallback(";
const FIXED_DEPS = "[router, setPaletteOpen],";
const BUGGY_DEPS = "[router],";

const BAIL_RULE = "react-hooks/preserve-manual-memoization";
const EFFECT_RULE = "react-hooks/set-state-in-effect";

let source: string;
let eslint: ESLint;

/**
 * ESLint 9 reads `eslint-suppressions.json` in its CLI layer, not in the
 * `ESLint` class, so these messages are unsuppressed — which is what we want.
 */
async function lint(text: string) {
  const [result] = await eslint.lintText(text, { filePath: TOP_BAR_PATH });
  return result.messages;
}

function errorsFrom(messages: Awaited<ReturnType<typeof lint>>, ruleId: string) {
  return messages.filter((m) => m.severity === 2 && m.ruleId === ruleId);
}

beforeAll(() => {
  source = readFileSync(TOP_BAR_PATH, "utf8");
  eslint = new ESLint({ cwd: process.cwd() });
});

describe("TopBar and the React Compiler", () => {
  it("lints TopBar with the compiler rules at error severity", async () => {
    const config = await eslint.calculateConfigForFile(TOP_BAR_PATH);

    // Turning either rule off would silence every assertion below without
    // failing any of them.
    expect(config.rules?.[BAIL_RULE]?.[0]).toBe(2);
    expect(config.rules?.[EFFECT_RULE]?.[0]).toBe(2);
  });

  it("calls its hooks by bare name, which is what the rules can see", () => {
    // `React.useEffect` and friends are invisible to the compiler rules. This
    // is the whole reason the file could report zero errors while carrying
    // four; it is asserted on the source because a namespaced call produces no
    // diagnostic to assert on.
    const namespaced = source.match(/React\.use[A-Z]\w*/g) ?? [];

    expect(namespaced).toEqual([]);
  });

  it("carries no opt-out the probes below cannot see", () => {
    /*
      `"use no memo"` is the one mask no diagnostic here can report: with
      eslint-plugin-react-hooks 7.0.1 the directive left BOTH probes below
      reporting exactly as they do without it, because it opts the component out
      of the compiler's output rather than out of its lint rules. Injecting it
      is therefore a change that passes every other assertion in this file, and
      only a source assertion refuses it.

      The blanket disable is covered by the probes as well; asserting it here
      names the mask rather than leaving it to a puzzling silence.
    */
    expect(source).not.toMatch(/["'`]use no memo["'`]/);
    expect(source).not.toMatch(/eslint-disable[^\n]*react-hooks/);
  });

  it("reports an injected effect violation, so the analysis is open", async () => {
    expect(source.split(CALLBACK_ANCHOR).length - 1).toBe(1);

    const mutated = source.replace(
      CALLBACK_ANCHOR,
      `  useEffect(() => setPaletteOpen(true), []);\n${CALLBACK_ANCHOR}`,
    );
    expect(mutated).not.toBe(source);

    // The load-bearing assertion. This exact probe was silent while the file
    // used `React.`-namespaced hooks, and it is silent under a blanket
    // `eslint-disable` of the rule — so an error here is the evidence that the
    // rules read this component, and nothing else is.
    expect(errorsFrom(await lint(mutated), EFFECT_RULE)).toHaveLength(1);
  });

  it("reports the original bail when the declared dependency is removed", async () => {
    expect(source.split(FIXED_DEPS).length - 1).toBe(1);

    const mutated = source.replace(FIXED_DEPS, BUGGY_DEPS);
    expect(mutated).not.toBe(source);

    const bails = errorsFrom(await lint(mutated), BAIL_RULE);

    expect(bails).toHaveLength(1);
    expect(bails[0].message).toContain("Compilation Skipped");
  });

  it("draws no React Compiler error as committed", async () => {
    const errors = (await lint(source)).filter(
      (message) => message.severity === 2 && message.ruleId?.startsWith("react-hooks/"),
    );

    // Attached in full: a bail names the callback it gave up on, and an effect
    // violation names the setState it found, which is the whole diagnosis.
    expect(errors.map((message) => `${message.ruleId}: ${message.message}`)).toEqual([]);
  });
});
