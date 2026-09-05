/**
 * Resolve what a Tailwind class list actually PAINTS for `outline` while the
 * element matches `:focus-visible`.
 *
 * Why this exists: `focus-visible:outline-2` does NOT set `outline-style` to a
 * literal. Tailwind v4 emits
 *
 *     .focus-visible\:outline-2 { &:focus-visible {
 *         outline-style: var(--tw-outline-style); outline-width: 2px; } }
 *     .outline-none            { --tw-outline-style: none; outline-style: none; }
 *
 * so an element carrying BOTH resolves `outline-style` to `none` and draws
 * nothing, even though `:focus-visible` matched and the width/colour applied.
 * Asserting that the class is *present* therefore proves nothing — the whole
 * point of this helper is to assert the resolved value instead.
 *
 * This is a cascade resolution of the CSS the real Tailwind compiler emits for
 * the given classes. It is NOT a browser: it models specificity + source order
 * + `@property` initial values for the handful of declaration shapes Tailwind
 * generates, and nothing else. The real-browser claim is `e2e/focus-ring.spec.ts`.
 *
 * This file lives in `__tests__/helpers/` on purpose: vitest's include glob is
 * `**\/*.test.{ts,tsx,mjs}`, so nothing here is collected as a test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { compile } from "tailwindcss";

/** Tailwind's `@property --tw-outline-style` initial value. */
const OUTLINE_STYLE_INITIAL = "solid";

type Compiler = { build: (candidates: string[]) => string };

let compilerPromise: Promise<Compiler> | null = null;

/**
 * One compiler for the whole file — instantiating it parses Tailwind's full
 * theme, which is the expensive part.
 *
 * `build()` is CUMULATIVE: it re-emits every candidate the compiler has ever
 * been handed, not just the ones passed to this call. Sharing the instance is
 * therefore only safe because `collectDeclarations` filters the emitted rules
 * back down to the class list under test — without that filter, a
 * `focus-visible:outline-solid` from one assertion silently repairs every
 * later one.
 */
function getCompiler(): Promise<Compiler> {
  compilerPromise ??= compile(`@import "tailwindcss";`, {
    base: process.cwd(),
    loadStylesheet: async (id: string) => {
      const resolved =
        id === "tailwindcss"
          ? path.join(process.cwd(), "node_modules/tailwindcss/index.css")
          : path.resolve(process.cwd(), id);
      return {
        path: resolved,
        base: path.dirname(resolved),
        content: readFileSync(resolved, "utf8"),
      };
    },
  }) as Promise<Compiler>;
  return compilerPromise;
}

type Declaration = {
  property: string;
  value: string;
  /** Class selector = 1 point, an extra `:focus-visible` = 2. */
  specificity: number;
  /** Later in the emitted sheet wins a specificity tie. */
  order: number;
};

/**
 * Pull the declarations out of the `@layer utilities` block, tagging each with
 * the specificity it would have on an element carrying every class, and
 * keeping only what applies in the requested state.
 *
 * Tailwind v4 emits exactly two shapes inside that layer:
 *   `.cls { decl; }`                        -> always applies
 *   `.cls { &:focus-visible { decl; } }`    -> applies only when focus-visible
 *
 * Rules for classes outside `applied` are dropped: the shared compiler emits
 * every candidate it has ever seen (see `getCompiler`).
 */
function collectDeclarations(
  css: string,
  applied: ReadonlySet<string>,
  focusVisible: boolean,
): Declaration[] {
  const start = css.indexOf("@layer utilities");
  if (start === -1) return [];
  const body = sliceBlock(css, css.indexOf("{", start));

  const out: Declaration[] = [];
  let order = 0;

  // Top-level rules of the utilities layer.
  const ruleRe = /\.((?:\\.|[^\s{,])+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRe.exec(body))) {
    const braceIndex = match.index + match[0].length - 1;
    const rule = sliceBlock(body, braceIndex);
    ruleRe.lastIndex = braceIndex + rule.length + 2;

    // `.focus-visible\:outline-2` in the sheet is `focus-visible:outline-2`
    // in the source: CSS escapes every character an identifier may not carry.
    if (!applied.has(match[1].replace(/\\(.)/g, "$1"))) continue;

    for (const decl of readDeclarations(rule)) {
      out.push({ ...decl, specificity: 1, order: order++ });
    }

    // Nested `&:focus-visible { … }` (and any other nested state we ignore).
    const nestedRe = /&([^{]*)\{/g;
    let nested: RegExpExecArray | null;
    while ((nested = nestedRe.exec(rule))) {
      const nestedBrace = nested.index + nested[0].length - 1;
      const nestedBody = sliceBlock(rule, nestedBrace);
      nestedRe.lastIndex = nestedBrace + nestedBody.length + 2;

      const selector = nested[1].trim();
      if (selector !== ":focus-visible") continue;
      if (!focusVisible) continue;
      for (const decl of readDeclarations(nestedBody)) {
        out.push({ ...decl, specificity: 2, order: order++ });
      }
    }
  }
  return out;
}

/** Text between `{` at `openIndex` and its matching `}`. */
function sliceBlock(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return "";
}

/** `prop: value;` pairs at this level only (nested blocks are skipped). */
function readDeclarations(block: string): { property: string; value: string }[] {
  const flat = block.replace(/[^{}]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  const out: { property: string; value: string }[] = [];
  for (const raw of flat.split(";")) {
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    const property = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!property || !value || property.startsWith("@")) continue;
    out.push({ property, value });
  }
  return out;
}

/** Highest specificity wins; a tie goes to whichever came later in the sheet. */
function winner(decls: Declaration[], property: string): string | undefined {
  let best: Declaration | undefined;
  for (const d of decls) {
    if (d.property !== property) continue;
    if (
      !best ||
      d.specificity > best.specificity ||
      (d.specificity === best.specificity && d.order > best.order)
    ) {
      best = d;
    }
  }
  return best?.value;
}

export type ResolvedOutline = {
  /** The painted `outline-style`, after substituting `--tw-outline-style`. */
  style: string;
  width: string | undefined;
  offset: string | undefined;
  color: string | undefined;
  /** False when the resolved style is `none`/`hidden` — i.e. nothing is drawn. */
  paints: boolean;
};

/**
 * Compile `classes` with the real Tailwind engine and resolve the outline
 * declarations that survive the cascade while the element is `:focus-visible`.
 */
export async function resolveFocusVisibleOutline(
  classes: readonly string[],
): Promise<ResolvedOutline> {
  const compiler = await getCompiler();
  const css = compiler.build([...classes]);
  const decls = collectDeclarations(css, new Set(classes), true);

  const outlineStyleVar =
    winner(decls, "--tw-outline-style") ?? OUTLINE_STYLE_INITIAL;
  const rawStyle = winner(decls, "outline-style") ?? "none";
  const style = rawStyle.includes("var(--tw-outline-style)")
    ? outlineStyleVar
    : rawStyle;

  return {
    style,
    width: winner(decls, "outline-width"),
    offset: winner(decls, "outline-offset"),
    color: winner(decls, "outline-color"),
    paints: style !== "none" && style !== "hidden",
  };
}

/** Split a `className` blob into candidate utilities, dropping `${…}` holes. */
export function classTokens(source: string): string[] {
  return source
    .replace(/\$\{[^}]*\}/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
