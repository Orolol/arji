// @vitest-environment node
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";

/**
 * `eslint-plugin-react-hooks` 7.0.1 only recognises a hook called by its BARE
 * name. In a file written `import * as React from "react"`, a
 * `React.useEffect(...)` is not a hook as far as the React Compiler rules are
 * concerned, so nothing inside it is analysed.
 *
 * There is no diagnostic for that. A file nobody reads and a file with nothing
 * wrong both report zero errors, which is how `TopBar` carried four real
 * `set-state-in-effect` violations through a "fix" (see
 * `topbar-react-compiler-bail.test.ts`, which pins TopBar alone). 26 further
 * files shared the blind spot across 161 call sites; converting them surfaced
 * five more violations that `npm run lint` had never reported, in
 * `ChatPageView`, `YourTurnBand`, `DeskCommandPalette`, `DismissDialog` and
 * `app/piscine-preview/page.tsx`.
 *
 * MEASURED on this plugin version, and the reason each probe below is shaped
 * the way it is:
 *
 *   React.useEffect + React.useState     SILENT — the defect
 *   bare useEffect  + React.useState     reports
 *   React.useEffect + bare useState      SILENT
 *
 * So it is the EFFECT call that has to be bare for the rule to see anything.
 * A probe that injects its own bare `useEffect` therefore reports even inside
 * an unconverted component: it measures the injection, not the file. That trap
 * is why the two probe styles below are kept apart and separately labelled —
 * they prove different things, and only one of them is about the namespace.
 *
 * `npm run lint` covers these rules but CI runs Vitest, so this file is the
 * only thing standing between the blind spot and a silent return. It runs
 * ESLint through the `ESLint` class, which does not apply
 * `eslint-suppressions.json` (a CLI-layer feature), so baselining a violation
 * cannot make these assertions pass.
 */

const ROOTS = ["components", "app", "hooks", "lib"] as const;
const NAMESPACED_HOOK = /React\.(use[A-Z]\w*)\s*[(<]/g;

/**
 * The scan below reads the CALL, never the import.
 *
 * MEASURED: what silences the rules is the `React.` member expression, not the
 * statement that bound `React`. `import React from "react"` with a
 * `React.useEffect` is exactly as dark as the namespace form — probed on
 * `components/ui/input.tsx`, no diagnostic either way.
 *
 * This scan used to require a literal `import * as React from "react";` before
 * it would look at a file, which was the same blind spot one level up: the 16
 * shadcn files in `components/ui/` write that import with NO trailing
 * semicolon, so a planted `React.useState` + `React.useEffect` violation in
 * `Input` passed this test while ESLint said nothing about it either. Matching
 * on the call site alone costs nothing and cannot be sidestepped by a
 * formatter, a default import, or an aliased one.
 */
const namespacedHookSites = (source: string): string[] =>
  source.match(NAMESPACED_HOOK) ?? [];
const EFFECT_RULE = "react-hooks/set-state-in-effect";

/**
 * The 26 files this conversion covered: every file that combined
 * `import * as React from "react"` with `React.use*` calls, 161 call sites.
 * The sweeps below are scoped to them, which is this change's blast radius.
 */
const CONVERTED = [
  "app/piscine-preview/page.tsx",
  "components/chat-page/ChatComposer.tsx",
  "components/chat-page/ChatPageView.tsx",
  "components/chat-page/ChatThread.tsx",
  "components/chat-page/DraftedEpicCard.tsx",
  "components/desk/AttentionRow.tsx",
  "components/desk/DeskCommandPalette.tsx",
  "components/desk/DeskComposer.tsx",
  "components/desk/NowDesk.tsx",
  "components/desk/WaveRunChips.tsx",
  "components/desk/YourTurnBand.tsx",
  "components/piscine/GhostInputPill.tsx",
  "components/piscine/TopBarMenu.tsx",
  "components/qa/DismissDialog.tsx",
  "components/qa/QaScreen.tsx",
  "components/qa/RunQaPassButton.tsx",
  "components/releases/ChangelogAgentPopover.tsx",
  "components/releases/ReleaseHistory.tsx",
  "components/releases/VersionPill.tsx",
  "components/settings-piscine/FullAutoBand.tsx",
  "components/ticket/AgentActivityBand.tsx",
  "components/ticket/CommentBubble.tsx",
  "components/ticket/TicketDescriptionCard.tsx",
  "components/ticket/TicketOverlay.tsx",
  "components/ticket/TicketOverlayProvider.tsx",
  "components/ticket/TicketScreenshots.tsx",
] as const;

/**
 * The components among those 26 that the React Compiler declines to analyse AT
 * ALL — a bail, which is a second and entirely separate blind spot from the
 * namespace one. Their hooks are bare like everyone else's, and the rules still
 * read nothing: a freshly injected `useState`/`useEffect` violation at the top
 * of the component body draws no diagnostic. Measured IDENTICAL before and
 * after the conversion, so converting them changed nothing here.
 *
 * This is not confined to the converted set. The same probe over the whole app
 * finds 48 bailed components out of 113 probeable ones — `AgentsWorkshopView`,
 * `NightRunDialog`, `RefinementButton`, most of `app/projects/[projectId]/*`
 * and more. That is a much larger defect than this ticket, and it is filed
 * separately rather than smuggled into a mechanical conversion; the sweep here
 * stays scoped to the files this change touched.
 *
 * This list is a known gap, not a permission. Shrinking it should FAIL this
 * test — delete the entry and keep the win. Growing it means a converted
 * component just went dark.
 */
const KNOWN_BAILED = [
  "components/chat-page/DraftedEpicCard.tsx",
  "components/desk/DeskComposer.tsx",
  "components/desk/NowDesk.tsx",
  "components/qa/QaScreen.tsx",
] as const;

/**
 * The five violations the conversion revealed, with the mutation that puts each
 * one back. Reverting a fix must make the rule speak again: that is what tells
 * a fixed component from one that merely stopped being read.
 */
const REVERTS: ReadonlyArray<{ file: string; from: string; to: string }[]> = [
  // ChatPageView — prop synced into state from an effect.
  [
    {
      file: "components/chat-page/ChatPageView.tsx",
      from: `  const [lastInitialProjectId, setLastInitialProjectId] =
    useState(initialProjectId);
  if (initialProjectId !== lastInitialProjectId) {
    setLastInitialProjectId(initialProjectId);
    if (initialProjectId) setChosenProjectId(initialProjectId);
  }`,
      to: `  useEffect(() => {
    if (initialProjectId) setChosenProjectId(initialProjectId);
  }, [initialProjectId]);`,
    },
  ],
  // YourTurnBand — the measure loop's setState, deliberate and scoped-disabled.
  [
    {
      file: "components/desk/YourTurnBand.tsx",
      from: `    // eslint-disable-next-line react-hooks/set-state-in-effect\n`,
      to: "",
    },
  ],
  // DeskCommandPalette — reset-on-close from an effect.
  [
    {
      file: "components/desk/DeskCommandPalette.tsx",
      from: `import { useMemo, useState } from "react";`,
      to: `import { useEffect, useMemo, useState } from "react";`,
    },
    {
      file: "components/desk/DeskCommandPalette.tsx",
      from: `  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setQuery("");
      setCursor(0);
    }
  }`,
      to: `  useEffect(() => {
    if (!open) {
      setQuery("");
      setCursor(0);
    }
  }, [open]);`,
    },
  ],
  // DismissDialog — reset-on-prop-change from an effect.
  [
    {
      file: "components/qa/DismissDialog.tsx",
      from: `import { useState } from "react";`,
      to: `import { useEffect, useState } from "react";`,
    },
    {
      file: "components/qa/DismissDialog.tsx",
      from: `  const resetKey = \`\${finding?.findingId ?? ""}:\${open}\`;
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (lastResetKey !== resetKey) {
    setLastResetKey(resetKey);
    setReason("");
  }`,
      to: `  useEffect(() => {
    setReason("");
  }, [finding?.findingId, open]);`,
    },
  ],
  // piscine-preview — client-only timestamp set from a mount effect.
  [
    {
      file: "app/piscine-preview/page.tsx",
      from: `import { useState, useSyncExternalStore } from "react";`,
      to: `import { useEffect, useState } from "react";`,
    },
    {
      file: "app/piscine-preview/page.tsx",
      from: `  const startedAt = useSyncExternalStore(
    subscribeChronoStartedAt,
    readChronoStartedAt,
    readNoChronoStartedAt,
  );`,
      to: `  const [startedAt, setStartedAt] = useState<string | null>(null);
  useEffect(() => {
    setStartedAt(new Date(Date.now() - 252_000).toISOString());
  }, []);`,
    },
  ],
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  for (const root of ROOTS) walk(root);
  return out.sort();
}

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

let eslint: ESLint;

async function effectErrors(text: string, rel: string) {
  const [result] = await eslint.lintText(text, {
    filePath: path.join(process.cwd(), rel),
  });
  // A mutation that breaks parsing would report zero rule errors and read as a
  // pass, so parse failures are surfaced rather than filtered away.
  const parseErrors = result.messages.filter((m) => !m.ruleId && m.severity === 2);
  return {
    parseErrors: parseErrors.map((m) => m.message),
    errors: result.messages.filter((m) => m.severity === 2 && m.ruleId === EFFECT_RULE),
  };
}

/**
 * Injects a SELF-CONTAINED `useState`/`useEffect` violation at the top of the
 * first component-level hook statement. Both hooks are bare and owned by the
 * probe, so this asks one question only: does the compiler enter this component
 * at all? It says NOTHING about whether the component's own hooks are visible —
 * measured identical on the namespaced and converted forms of all 26 files.
 */
function withBailProbe(text: string): string | null {
  const anchor =
    /^(\s+)(?:const\s[^=]*=\s*)?(?:useState|useMemo|useCallback|useRef|useEffect|useLayoutEffect|useContext)\s*[(<]/;
  const lines = text.split("\n");
  const index = lines.findIndex((line) => anchor.test(line));
  if (index < 0) return null;
  const indent = lines[index].match(anchor)![1];
  lines.splice(
    index,
    0,
    `${indent}const [__probe, __setProbe] = useState(0);`,
    `${indent}useEffect(() => __setProbe(1), []);`,
    `${indent}void __probe;`,
  );
  return lines.join("\n");
}

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
});

describe("React Compiler rules and `React.`-namespaced hooks", () => {
  it("keeps the compiler rules at error severity", async () => {
    const config = await eslint.calculateConfigForFile(
      path.join(process.cwd(), "components/piscine/TopBar.tsx"),
    );

    // Downgrading either would silence the sweep below without failing it.
    expect(config.rules?.[EFFECT_RULE]?.[0]).toBe(2);
    expect(config.rules?.["react-hooks/rules-of-hooks"]?.[0]).toBe(2);
  });

  it("flags a namespaced hook whatever bound `React`", () => {
    /*
      The scanner's own regression test. Every form below is dark to the
      compiler rules — measured, not assumed — so every form has to be caught,
      including the semicolon-less namespace import that `components/ui/*` uses
      and that this scan once skipped entirely.
    */
    const body = `\n  const [n, setN] = React.useState(0)\n  React.useEffect(() => setN(1), [])\n`;

    expect(namespacedHookSites(`import * as React from "react";${body}`)).toHaveLength(2);
    expect(namespacedHookSites(`import * as React from "react"${body}`)).toHaveLength(2);
    expect(namespacedHookSites(`import React from "react"${body}`)).toHaveLength(2);

    // Type positions are not call sites: `React.ComponentProps` and friends
    // are what most converted files keep the namespace import FOR.
    expect(
      namespacedHookSites(
        `import * as React from "react";\nfunction I(p: React.ComponentProps<"input">) {\n  const [n, setN] = useState(0);\n  useEffect(() => setN(1), []);\n}`,
      ),
    ).toEqual([]);
  });

  it("has no source file calling its hooks through the React namespace", () => {
    const offenders = sourceFiles()
      .map((rel) => {
        const sites = namespacedHookSites(read(rel));
        return sites.length > 0 ? `${rel} (${sites.length} call sites)` : null;
      })
      .filter((row): row is string => row !== null);

    /*
      A file listed here reports zero React Compiler errors because nothing
      reads it, not because it is clean. Converting the call sites to bare
      imports is the whole fix — `import * as React from "react"` may STAY for
      the type positions (`React.ComponentProps` and friends), which the rules
      never look at, and most converted files keep it for exactly that.
    */
    expect(offenders).toEqual([]);
  });

  describe("the five violations the conversion revealed", () => {
    it.each(REVERTS.map((steps) => [steps[0].file, steps] as const))(
      "%s reports again when its fix is reverted",
      async (rel, steps) => {
        const source = read(rel);

        const mutated = steps.reduce((text, step) => {
          // An anchor that stopped matching would leave the source untouched
          // and the probe would report nothing, passing for the wrong reason.
          expect(
            text.split(step.from).length - 1,
            `anchor should appear exactly once in ${rel}: ${step.from.slice(0, 60)}`,
          ).toBe(1);
          return text.replace(step.from, step.to);
        }, source);
        expect(mutated).not.toBe(source);

        const clean = await effectErrors(source, rel);
        expect(clean.parseErrors).toEqual([]);
        expect(clean.errors).toEqual([]);

        const reverted = await effectErrors(mutated, rel);
        expect(reverted.parseErrors).toEqual([]);
        // The load-bearing assertion: this exact violation was invisible while
        // the file called its hooks through the namespace.
        expect(reverted.errors.length).toBeGreaterThanOrEqual(1);
      },
    );
  });

  it("still reads the converted files' own hooks, and says which it cannot check", async () => {
    /*
      The honest namespace probe: inject a setState into an effect the file
      ALREADY OWNS, keeping the file's own call form, then re-namespace the
      same probed source. Bare must report and namespaced must go silent — that
      differential is the defect itself, reproduced per file.

      It only applies where the shape allows (an effect with a block body, with
      a `useState` setter declared above it). Files without one are covered by
      the source scan above, not by this.
    */
    const setter = /const \[\s*\w+\s*,\s*(set\w+)\s*\]\s*(?::[^=]*)?=\s*useState/g;
    const effect = /\b(?:useEffect|useLayoutEffect)\(\s*\(\)\s*=>\s*\{/g;
    const renamespace = (text: string) =>
      text.replace(
        /(?<!\.)\b(use(?:Effect|LayoutEffect|State|Memo|Callback|Ref))(\s*[(<])/g,
        "React.$1$2",
      );

    const checked: string[] = [];
    for (const rel of CONVERTED) {
      const source = read(rel);

      const setters = [...source.matchAll(setter)].map((m) => ({
        name: m[1],
        at: m.index!,
      }));
      if (setters.length === 0) continue;
      const target = [...source.matchAll(effect)].find((e) =>
        setters.some((s) => s.at < e.index!),
      );
      if (!target) continue;
      const name = setters.filter((s) => s.at < target.index!).at(-1)!.name;
      const at = target.index! + target[0].length;
      const probed = `${source.slice(0, at)}\n    ${name}(null as never);${source.slice(at)}`;

      const bare = await effectErrors(probed, rel);
      if (bare.parseErrors.length > 0 || bare.errors.length === 0) continue;
      const masked = await effectErrors(renamespace(probed), rel);
      if (masked.parseErrors.length > 0) continue;

      expect(
        masked.errors,
        `${rel}: the same probe must go silent once the hooks are namespaced`,
      ).toEqual([]);
      checked.push(rel);
    }

    // Guards the probe itself: a refactor that removes every block-bodied
    // effect would quietly reduce this to a vacuous pass.
    expect(checked.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it("pins the components the compiler still declines to analyse", async () => {
    const bailed: string[] = [];
    for (const rel of CONVERTED) {
      const probed = withBailProbe(read(rel));
      if (!probed) continue;
      const result = await effectErrors(probed, rel);
      if (result.parseErrors.length > 0) continue;
      if (result.errors.length === 0) bailed.push(rel);
    }

    /*
      Every component here is dark to the React Compiler for a reason that is
      NOT the namespace: their hooks are already bare. `NowDesk` is the clearest
      case — `react-hooks/rules-of-hooks` fires inside it while every
      compiler-backed rule stays silent, including a violation injected at the
      very first line of the component body.

      Left as a separate defect rather than folded into the conversion, because
      finding what makes each component un-compilable is real work, not a
      mechanical rewrite.
    */
    expect(bailed.sort()).toEqual([...KNOWN_BAILED].sort());
  }, 30_000);
});
