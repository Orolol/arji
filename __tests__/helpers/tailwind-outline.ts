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
 * THE COLOUR IS RESOLVED TOO, once per theme. The class list is compiled
 * against the app's real stylesheet (`app/globals.css`), not the bare
 * framework theme: `focus-visible:outline-ring` takes its colour from
 * `--color-ring`, which only that sheet defines (`@theme inline`, so the
 * utility emits `outline-color: var(--ring)`), and `--ring` has one value under
 * `:root` (day) and another under `.dark` (night). Against the bare theme the
 * utility emitted nothing and the colour read `undefined` for every control in
 * the app, so a `transparent` ring — `outline-style: solid`, 2px wide, invisible
 * — passed every assertion. `colorIn` is the colour with every `var(--…)`
 * substituted from the theme that is on; `colorPaints` says whether it draws.
 *
 * This is a cascade resolution of the CSS the real Tailwind compiler emits for
 * the given classes. It is NOT a browser: it models specificity + source order
 * + `@property` initial values + the two layers that reach an outline
 * (`@layer base`'s universal rule, `@layer utilities`) + nested `@supports`
 * blocks (taken as true — every browser the e2e specs measure supports what
 * Tailwind guards with them, `color-mix()` above all) for the handful of
 * declaration shapes Tailwind generates, and nothing else. Unlayered rules,
 * `@media` conditions, `!important`, inheritance and the element's own ground
 * are out of the model. The real-browser claim is `e2e/focus-ring.spec.ts`
 * and `e2e/focus-ring-inputs.spec.ts`, which also read the colour Chrome
 * paints against a real ground in both themes.
 *
 * This file lives in `__tests__/helpers/` on purpose: vitest's include glob is
 * `**\/*.test.{ts,tsx,mjs}`, so nothing here is collected as a test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { compile } from "tailwindcss";

/** Tailwind's `@property --tw-outline-style` initial value. */
const OUTLINE_STYLE_INITIAL = "solid";

/**
 * The sheet the app really loads (`app/layout.tsx`), compiled as-is. Every
 * `@import` in it is resolved by {@link resolveStylesheet}; a sheet that
 * stops compiling here would stop compiling in the build too.
 */
const APP_STYLESHEET = path.join(process.cwd(), "app", "globals.css");

/**
 * The two variable sets the app defines: `:root` is day; `.dark` is layered on
 * top of it for night (`next-themes` puts that class on `<html>`).
 */
export const THEMES = ["day", "night"] as const;
export type Theme = (typeof THEMES)[number];

/** Passes of `var()` substitution before a cycle is given up on. */
const MAX_VAR_DEPTH = 16;

type Compiler = { build: (candidates: string[]) => string };

let compilerPromise: Promise<Compiler> | null = null;

/**
 * One compiler for the whole file — instantiating it parses Tailwind's full
 * theme and the app's sheet, which is the expensive part.
 *
 * `build()` is CUMULATIVE: it re-emits every candidate the compiler has ever
 * been handed, not just the ones passed to this call. Sharing the instance is
 * therefore only safe because `collectDeclarations` filters the emitted rules
 * back down to the class list under test — without that filter, a
 * `focus-visible:outline-solid` from one assertion silently repairs every
 * later one.
 */
function getCompiler(): Promise<Compiler> {
  compilerPromise ??= compile(readFileSync(APP_STYLESHEET, "utf8"), {
    base: path.dirname(APP_STYLESHEET),
    loadStylesheet: async (id: string, base: string) => {
      const resolved = resolveStylesheet(id, base);
      return {
        path: resolved,
        base: path.dirname(resolved),
        content: readFileSync(resolved, "utf8"),
      };
    },
  }) as Promise<Compiler>;
  return compilerPromise;
}

/**
 * `@import` resolution the way the build does it. A relative id is taken
 * against the importing sheet; a bare package id goes through the package's
 * `style` export condition, which is how `tailwindcss` (`index.css`),
 * `tw-animate-css` and `shadcn/tailwind.css` all publish their sheets. An
 * import this cannot place throws by name rather than compiling a sheet with
 * a hole in it.
 */
function resolveStylesheet(id: string, base: string): string {
  if (id.startsWith(".") || path.isAbsolute(id)) return path.resolve(base, id);

  const match = id.match(/^((?:@[^/]+\/)?[^/]+)(\/.+)?$/);
  if (!match) throw new Error(`cannot resolve @import "${id}"`);
  const [, name, subpath = ""] = match;

  const packageDir = path.join(process.cwd(), "node_modules", name);
  const manifest = JSON.parse(
    readFileSync(path.join(packageDir, "package.json"), "utf8"),
  ) as { exports?: Record<string, unknown>; style?: string };

  const entry = manifest.exports?.[`.${subpath}`];
  const target =
    typeof entry === "string"
      ? entry
      : ((entry as { style?: string } | undefined)?.style ??
        (subpath === "" ? manifest.style : undefined));
  if (!target) {
    throw new Error(
      `@import "${id}": ${name} publishes no stylesheet under the "style" ` +
        `export condition`,
    );
  }
  return path.join(packageDir, target);
}

/* ------------------------------------------------------------------ */
/* A block-level reading of the emitted sheet                          */
/* ------------------------------------------------------------------ */

type CssItem =
  | { kind: "declaration"; property: string; value: string }
  | { kind: "block"; prelude: string; body: string };

/**
 * The declarations and nested blocks of one body, at that level only and in
 * source order. Nested order matters: Tailwind emits a `@supports` override
 * AFTER the declaration it overrides, and later wins.
 *
 * Braces and semicolons are taken literally — the compiler's output carries
 * no comments, and none of the values this helper reads contain either.
 */
function parseBody(text: string): CssItem[] {
  const items: CssItem[] = [];
  let depth = 0;
  let segmentStart = 0;
  let bodyStart = -1;

  const declaration = (raw: string) => {
    const colon = raw.indexOf(":");
    if (colon === -1) return;
    const property = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (!property || !value || property.startsWith("@")) return;
    items.push({ kind: "declaration", property, value });
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        items.push({
          kind: "block",
          prelude: text.slice(segmentStart, bodyStart).trim(),
          body: text.slice(bodyStart + 1, i),
        });
        segmentStart = i + 1;
      }
    } else if (char === ";" && depth === 0) {
      declaration(text.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }
  declaration(text.slice(segmentStart));
  return items;
}

function childBlocks(text: string): Array<{ prelude: string; body: string }> {
  return parseBody(text).filter((item) => item.kind === "block");
}

function selectorsOf(prelude: string): string[] {
  return prelude.split(",").map((selector) => selector.trim());
}

type Declaration = {
  property: string;
  value: string;
  /**
   * Base layer = 0, class selector = 1, an extra `:focus-visible` = +2. The
   * cascade layers are folded in here: `@layer base` loses to any utility
   * whatever its selector, which the ordering 0 < 1 reproduces.
   */
  specificity: number;
  /** Later in the emitted sheet wins a specificity tie. */
  order: number;
};

/**
 * Pull out every declaration that applies to an element carrying every class
 * in `applied`, tagged with the specificity it has, keeping only what applies
 * in the requested state.
 *
 * Two layers reach an outline:
 *   `@layer base`      `* { outline-color: … }` — the app gives every element
 *                      `outline-ring/50`, so a ring with no colour utility is
 *                      not colourless; it is this.
 *   `@layer utilities` `.cls { decl; }`                     -> always applies
 *                      `.cls { &:focus-visible { decl; } }` -> focus-visible only
 *
 * Rules for classes outside `applied` are dropped: the shared compiler emits
 * every candidate it has ever seen (see `getCompiler`).
 */
function collectDeclarations(
  css: string,
  applied: ReadonlySet<string>,
  focusVisible: boolean,
): Declaration[] {
  const out: Declaration[] = [];
  let order = 0;
  const sink = (property: string, value: string, specificity: number) => {
    out.push({ property, value, specificity, order: order++ });
  };

  for (const layer of childBlocks(css)) {
    if (layer.prelude === "@layer base") {
      for (const rule of childBlocks(layer.body)) {
        if (!selectorsOf(rule.prelude).includes("*")) continue;
        ruleDeclarations(rule.body, 0, focusVisible, sink);
      }
    } else if (layer.prelude === "@layer utilities") {
      for (const rule of childBlocks(layer.body)) {
        if (!rule.prelude.startsWith(".")) continue;
        // `.focus-visible\:outline-2` in the sheet is `focus-visible:outline-2`
        // in the source: CSS escapes every character an identifier may not
        // carry.
        const className = rule.prelude.slice(1).replace(/\\(.)/g, "$1");
        if (!applied.has(className)) continue;
        ruleDeclarations(rule.body, 1, focusVisible, sink);
      }
    }
  }
  return out;
}

/**
 * One rule body, with its nested blocks:
 *   `@supports (…) { … }`   applies as-is (a modern browser — see the header)
 *   `&:focus-visible { … }` applies only in that state, two points up
 *   anything else            a state the element is not in; not modelled
 */
function ruleDeclarations(
  body: string,
  specificity: number,
  focusVisible: boolean,
  sink: (property: string, value: string, specificity: number) => void,
): void {
  for (const item of parseBody(body)) {
    if (item.kind === "declaration") {
      sink(item.property, item.value, specificity);
    } else if (item.prelude.startsWith("@supports")) {
      ruleDeclarations(item.body, specificity, focusVisible, sink);
    } else if (item.prelude === "&:focus-visible" && focusVisible) {
      ruleDeclarations(item.body, specificity + 2, focusVisible, sink);
    }
  }
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

/* ------------------------------------------------------------------ */
/* Custom properties, per theme                                        */
/* ------------------------------------------------------------------ */

/**
 * The custom properties each theme defines, read off a compiled sheet.
 *
 * Day is everything declared on `:root` — the app's own block and Tailwind's
 * `:root, :host` theme layer alike, later declarations winning. Night is day
 * with `.dark` laid over it: both selectors match `<html>` when the class is
 * on, and the app keeps every alias (`--x: var(--y)`) in `:root` only, so an
 * alias follows whichever theme is on by itself (see the comment above
 * `:root` in `app/globals.css`).
 *
 * `@layer` blocks are looked into; conditional at-rules (`@media`, `@supports`)
 * are not — the app puts no theme variable under one.
 */
export function themeVariables(
  css: string,
): Record<Theme, ReadonlyMap<string, string>> {
  const day = new Map<string, string>();
  const dark = new Map<string, string>();

  const visit = (body: string) => {
    for (const block of childBlocks(body)) {
      if (block.prelude.startsWith("@layer")) {
        visit(block.body);
        continue;
      }
      if (block.prelude.startsWith("@")) continue;

      const selectors = selectorsOf(block.prelude);
      const target = selectors.includes(":root")
        ? day
        : selectors.includes(".dark")
          ? dark
          : null;
      if (!target) continue;

      for (const item of parseBody(block.body)) {
        if (item.kind === "declaration" && item.property.startsWith("--")) {
          target.set(item.property, item.value);
        }
      }
    }
  };
  visit(css);

  return { day, night: new Map([...day, ...dark]) };
}

/**
 * `value` with every `var(--name)` / `var(--name, fallback)` replaced from
 * `vars`, repeatedly, until nothing changes. A name `vars` does not define
 * takes its fallback, or stays as written — an unresolved `var(--…)` is then
 * visible to {@link colorPaints}, which treats it as not painting: a token
 * the theme never defined is exactly a ring nobody can see.
 */
export function substituteVars(
  value: string,
  vars: ReadonlyMap<string, string>,
): string {
  let current = value;
  for (let pass = 0; pass < MAX_VAR_DEPTH; pass++) {
    const next = substituteOnce(current, vars);
    if (next === current) break;
    current = next;
  }
  return current;
}

function substituteOnce(
  value: string,
  vars: ReadonlyMap<string, string>,
): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = value.indexOf("var(", i);
    if (at === -1) return out + value.slice(i);
    const close = closingParen(value, at + 3);
    if (close === -1) return out + value.slice(i);

    const inner = value.slice(at + 4, close);
    const comma = topLevelIndex(inner, ",");
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    const replacement = vars.get(name) ?? fallback;

    out += value.slice(i, at) + (replacement ?? value.slice(at, close + 1));
    i = close + 1;
  }
}

/** Index of the `)` matching the `(` at `openIndex`, or -1. */
function closingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** First index of `char` outside any parentheses, or -1. */
function topLevelIndex(text: string, char: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === char && depth === 0) return i;
  }
  return -1;
}

/** `text` split on `separator`, ignoring separators inside parentheses. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/* ------------------------------------------------------------------ */
/* Does a colour draw anything?                                        */
/* ------------------------------------------------------------------ */

/** A zero alpha in any of the notations Tailwind and the app's tokens use. */
const ZERO_ALPHA = /^0*(?:\.0+)?%?$/;

/**
 * Whether a resolved `outline-color` puts any ink on the screen.
 *
 * Rejected: nothing at all, the `transparent` keyword, a hex or functional
 * colour whose alpha is zero, a `color-mix()` that keeps none of a colour
 * that paints, and a `var(--…)` still standing after substitution (the theme
 * never defined it). Everything else — a named colour, `currentcolor`, an
 * opaque or half-opaque literal, a mix that keeps some of a real colour — is
 * taken to paint. Whether it CONTRASTS with what it sits on is a claim about
 * a rendered page, and belongs to the e2e specs.
 */
export function colorPaints(color: string | undefined): boolean {
  if (color === undefined) return false;
  const c = color.trim().toLowerCase();
  if (c === "" || c === "transparent" || c.includes("var(")) return false;
  if (/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/.test(c)) return false;

  const fn = c.match(/^([a-z-]+)\((.*)\)$/);
  if (!fn) return true;
  const [, name, args] = fn;

  if (name === "color-mix") {
    // color-mix(in <space>, <color> [<share>%], <color> [<share>%])
    return splitTopLevel(args, ",")
      .slice(1)
      .some((part) => {
        const component = part.trim().match(/^(.*?)(?:\s+([\d.]+)%)?$/);
        if (!component) return false;
        const [, mixed, share] = component;
        if (share !== undefined && Number(share) === 0) return false;
        return colorPaints(mixed);
      });
  }

  // rgb() / hsl() / oklch() / color() and friends: the alpha is what follows
  // `/`, or the fourth comma-separated argument of the legacy syntax.
  const slash = topLevelIndex(args, "/");
  const legacy = splitTopLevel(args, ",");
  const alpha =
    slash !== -1
      ? args.slice(slash + 1).trim()
      : legacy.length === 4
        ? legacy[3].trim()
        : undefined;
  return alpha === undefined || !ZERO_ALPHA.test(alpha);
}

/* ------------------------------------------------------------------ */
/* The resolution                                                      */
/* ------------------------------------------------------------------ */

export type ResolvedOutline = {
  /** The painted `outline-style`, after substituting `--tw-outline-style`. */
  style: string;
  width: string | undefined;
  offset: string | undefined;
  /**
   * `outline-color` as the class list declares it, unresolved — `var(--ring)`
   * for `outline-ring`, the app's theme being `inline`. Undefined when no
   * utility in the list names a colour.
   */
  color: string | undefined;
  /**
   * What is painted, per theme: `color`, or `@layer base`'s universal
   * `outline-color` when no utility names one, with every `var(--…)`
   * substituted from the theme that is on. A complete ring assertion is
   * `paints` AND `colorPaints(colorIn[theme])` for each of {@link THEMES}.
   */
  colorIn: Record<Theme, string | undefined>;
  /**
   * False when the resolved style is `none`/`hidden` — i.e. nothing is drawn.
   * Says nothing about the colour: see `colorIn`.
   */
  paints: boolean;
};

/**
 * Compile `classes` with the real Tailwind engine against the app's sheet and
 * resolve the outline declarations that survive the cascade while the element
 * is `:focus-visible`.
 */
export async function resolveFocusVisibleOutline(
  classes: readonly string[],
): Promise<ResolvedOutline> {
  const compiler = await getCompiler();
  const css = compiler.build([...classes]);
  const decls = collectDeclarations(css, new Set(classes), true);
  const declared = decls.filter((d) => d.specificity > 0);

  const outlineStyleVar =
    winner(decls, "--tw-outline-style") ?? OUTLINE_STYLE_INITIAL;
  const rawStyle = winner(decls, "outline-style") ?? "none";
  const style = rawStyle.includes("var(--tw-outline-style)")
    ? outlineStyleVar
    : rawStyle;

  const painted = winner(decls, "outline-color");
  const vars = themeVariables(css);
  const colorIn = Object.fromEntries(
    THEMES.map((theme) => [
      theme,
      painted === undefined ? undefined : substituteVars(painted, vars[theme]),
    ]),
  ) as Record<Theme, string | undefined>;

  return {
    style,
    width: winner(decls, "outline-width"),
    offset: winner(decls, "outline-offset"),
    color: winner(declared, "outline-color"),
    colorIn,
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
