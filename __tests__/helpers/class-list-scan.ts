/**
 * Find the Tailwind class lists in a source file, without being fooled by the
 * punctuation that surrounds them.
 *
 * WHY THIS PARSES INSTEAD OF PATTERN-MATCHING. Two scanners have now lost a
 * control to their own guesswork, and both failed silently:
 *
 *   1. A regex pass that treated comments as a joinable separator had no idea
 *      what a comment was, so this repository's own convention — naming a
 *      utility between backticks — read as a template literal, cut one
 *      element's class list in two, and dropped it from the sweep
 *      (B-arij-206). The failure surfaced as `expected 39 to be greater than
 *      or equal to 40`.
 *
 *   2. Its hand-rolled replacement knew about comments but still guessed at
 *      TSX: it opened a regex on any `/` whose previous significant character
 *      could not end an expression. In `</span><input className="…" />` the
 *      slash of the closing tag follows `<`, so that "regex" ran on to the
 *      slash of the next self-closing tag and swallowed the className between
 *      them. Zero literals, no assertion naming the loss.
 *
 * Both holes are one mistake at different depths: TSX is not a regular
 * language, and every approximation of it drops sites without saying so. So
 * this module hands the file to the TypeScript parser — already a direct
 * dependency, and the same one the build uses. A `/` is then never ambiguous,
 * because the parser knows whether it sits in an expression, a JSX child or a
 * regex.
 *
 * String contents, template holes, regex bodies, JSX text and comments are
 * blanked into a `skeleton` of the same length, which keeps every offset valid
 * for line numbers and makes brace/paren balancing safe.
 *
 * It lives in `__tests__/helpers/` on purpose: vitest's include glob is
 * `**\/*.test.{ts,tsx,mjs}`, so nothing here is collected as a test.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/* ------------------------------------------------------------------ */
/* Lexing                                                              */
/* ------------------------------------------------------------------ */

export interface SourceLiteral {
  /** Offset of the opening quote. */
  start: number;
  /** Offset one past the closing quote. */
  end: number;
  /**
   * The literal's text with escapes unwrapped and `${…}` holes replaced by a
   * space, so adjacent utilities never fuse across an interpolation.
   */
  value: string;
  quote: '"' | "'" | "`";
}

export interface LexedSource {
  literals: SourceLiteral[];
  /**
   * The source with comments and string contents replaced by spaces (newlines
   * preserved). Same length as the input, so every offset still lines up.
   */
  skeleton: string;
  /**
   * `const BOX = "flex h-[34px] … border-[1.5px] border-border"` — a class
   * string held in a named constant and spread into `cn(BOX, …)` at the use
   * site. The declaration is not inside any `className` or `cn(…)`, so element
   * grouping cannot see it as a literal; without resolving the name, half of
   * the element's class list is invisible. See {@link elementClassLists}.
   */
  constants: Map<string, string>;
}

/**
 * Both rules lex every file, and the sweep runs both over the whole tree.
 * Parsing each source once keeps that to one pass per file.
 */
const lexed = new Map<string, LexedSource>();

/**
 * One parse of a TS/TSX source, emitting its string and template literals and
 * blanking everything a class list can hide behind.
 */
export function lexSource(source: string): LexedSource {
  const memoized = lexed.get(source);
  if (memoized) return memoized;

  const tree = ts.createSourceFile(
    "scanned.tsx",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TSX,
  );

  const literals: SourceLiteral[] = [];
  /** Ranges the comment pass must step over rather than read. */
  const opaque: Span[] = [];
  const skeleton = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = Math.max(from, 0); k < to && k < skeleton.length; k++) {
      if (skeleton[k] !== "\n") skeleton[k] = " ";
    }
  };

  const keep = (node: ts.Node, value: string) => {
    const start = node.getStart(tree);
    literals.push({
      start,
      end: node.end,
      value,
      quote: source[start] as SourceLiteral["quote"],
    });
    blank(start + 1, node.end - 1);
    opaque.push({ start, end: node.end });
  };

  const constants = new Map<string, string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      constants.set(node.name.text, node.initializer.text);
    }

    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
        keep(node, (node as ts.LiteralLikeNode).text);
        return;

      case ts.SyntaxKind.TemplateExpression: {
        // `${…}` is code, not classes: join the fixed chunks with a space so
        // `a-${x}b` never yields the token `a-b`, and do not descend into the
        // holes — an expression's own literals are not this element's list.
        const template = node as ts.TemplateExpression;
        keep(
          node,
          [
            template.head.text,
            ...template.templateSpans.map((span) => span.literal.text),
          ].join(" "),
        );
        return;
      }

      // Neither can hold a class list, and both can hold punctuation that
      // would derail the comment pass — a `//` inside a URL-shaped regex, an
      // apostrophe in prose. Blank them and step over them.
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.JsxText:
        blank(node.pos, node.end);
        opaque.push({ start: node.pos, end: node.end });
        return;
    }
    node.forEachChild(visit);
  };
  visit(tree);

  // The parser reports comments as trivia rather than as nodes. Everything
  // that could disguise one is blanked and recorded above, so a `//` or `/*`
  // outside those ranges is unambiguously a comment.
  literals.sort((a, b) => a.start - b.start);
  opaque.sort((a, b) => a.start - b.start);
  let range = 0;
  let i = 0;
  while (i < source.length) {
    while (range < opaque.length && opaque[range].end <= i) range++;
    if (range < opaque.length && i >= opaque[range].start) {
      i = opaque[range].end;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "/") {
      let j = i;
      while (j < source.length && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const j = close === -1 ? source.length : close + 2;
      blank(i, j);
      i = j;
      continue;
    }
    i++;
  }

  const result: LexedSource = {
    literals,
    skeleton: skeleton.join(""),
    constants,
  };
  lexed.set(source, result);
  return result;
}

/* ------------------------------------------------------------------ */
/* Grouping literals into class lists                                  */
/* ------------------------------------------------------------------ */

export interface ClassListSite {
  file: string;
  line: number;
  classes: string[];
}

/** Split a `className` blob into candidate utilities, dropping `${…}` holes. */
export function classTokens(source: string): string[] {
  return source
    .replace(/\$\{[^}]*\}/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * ADJACENT grouping — the conservative one, and the one the paint sweep uses.
 *
 * Literals separated only by whitespace, commas or comments are one class list:
 * the shape of a `cn(…)` argument list and of a `cva` base array, where
 * `outline-none` and the focus ring routinely sit on different lines of the
 * same element.
 *
 * It deliberately stops at an expression. `cn("outline-none focus-visible:
 * outline-2", cond && "focus-visible:outline-solid")` is TWO groups here, and
 * that is correct for the paint question: the ring only paints when `cond`
 * holds, so merging the branches in would hide a real defect behind a
 * conditional.
 */
export function adjacentClassLists(
  source: string,
  file: string,
): ClassListSite[] {
  const { literals, skeleton } = lexSource(source);

  const clusters: SourceLiteral[][] = [];
  for (const [index, literal] of literals.entries()) {
    const previous = literals[index - 1];
    const gap =
      previous === undefined
        ? null
        : skeleton.slice(previous.end, literal.start);
    if (gap !== null && /^[\s,]*$/.test(gap)) clusters.at(-1)!.push(literal);
    else clusters.push([literal]);
  }

  return clusters.map((cluster) => ({
    file,
    line: lineOf(source, cluster[0].start),
    classes: classTokens(cluster.map((l) => l.value).join(" ")),
  }));
}

/**
 * ELEMENT grouping — every literal reached from one `className` attribute or
 * one class-builder call, conditional branches included.
 *
 * The undeclared-affordance question is "does this element offer ANY focus
 * affordance", so it needs the whole element and not an adjacency run. Under
 * adjacent grouping `CheckMark` and `UpNextBand` read as bare `outline-none`
 * because their ring hangs off `onToggle &&` / a `selected` ternary — a false
 * accusation. Under element grouping they read correctly.
 *
 * Literals that belong to no `className` / builder call are dropped: a
 * module-level `const CHIP_BASE = "…"` is not an element, and its affordance
 * legitimately lives at the use site.
 */
export function elementClassLists(
  source: string,
  file: string,
): ClassListSite[] {
  const { literals, skeleton, constants } = lexSource(source);
  const spans = outermostSpans(skeleton);

  const grouped = new Map<number, SourceLiteral[]>();
  for (const literal of literals) {
    const span = spans.findIndex(
      (s) => literal.start >= s.start && literal.end <= s.end,
    );
    if (span === -1) continue;
    const bucket = grouped.get(span);
    if (bucket) bucket.push(literal);
    else grouped.set(span, [literal]);
  }

  return [...grouped.entries()]
    .map(([span, group]) => ({
      file,
      line: lineOf(source, spans[span].start),
      classes: classTokens(
        [
          ...referencedConstants(
            skeleton.slice(spans[span].start, spans[span].end),
            constants,
          ),
          ...group.map((l) => l.value),
        ].join(" "),
      ),
    }))
    .sort((a, b) => a.line - b.line);
}

/**
 * The class strings a span pulls in by name.
 *
 * `FieldBoxInput` is why this exists: it renders `cn(BOX, "… outline-none",
 * "focus-visible:border-border-strong", …)`, and its 1.5px border lives in
 * `BOX`. Reading only the inline literals makes that a border COLOUR with no
 * border width — which paints nothing — so the element reads as having no
 * affordance when in fact it has a real one. Resolving the name is what tells
 * the two cases apart.
 *
 * The skeleton has string contents blanked, so an identifier-shaped word
 * inside a class string can never be mistaken for a reference.
 */
function referencedConstants(
  spanText: string,
  constants: Map<string, string>,
): string[] {
  const resolved: string[] = [];
  for (const match of spanText.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const value = constants.get(match[0]);
    if (value !== undefined) resolved.push(value);
  }
  return resolved;
}

interface Span {
  start: number;
  end: number;
}

/** `className=` attributes and `cn(` / `clsx(` / `cva(` calls, nested ones merged away. */
function outermostSpans(skeleton: string): Span[] {
  const spans: Span[] = [];

  for (const match of skeleton.matchAll(/\bclassName\s*=\s*/g)) {
    const valueAt = match.index + match[0].length;
    const opener = skeleton[valueAt];
    if (opener === "{") {
      const end = matchingClose(skeleton, valueAt, "{", "}");
      if (end !== -1) spans.push({ start: match.index, end: end + 1 });
    } else if (opener === '"' || opener === "'" || opener === "`") {
      const end = skeleton.indexOf(opener, valueAt + 1);
      if (end !== -1) spans.push({ start: match.index, end: end + 1 });
    }
  }

  for (const match of skeleton.matchAll(/\b(?:cn|clsx|cva|twMerge)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const end = matchingClose(skeleton, open, "(", ")");
    if (end !== -1) spans.push({ start: match.index, end: end + 1 });
  }

  // Keep only the outermost: a `className={cn(…)}` must not be split into two.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const outermost: Span[] = [];
  for (const span of spans) {
    const last = outermost.at(-1);
    if (last && span.end <= last.end) continue;
    outermost.push(span);
  }
  return outermost;
}

/** Offset of the `close` matching the `open` at `openIndex`, or -1. */
function matchingClose(
  skeleton: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = openIndex; i < skeleton.length; i++) {
    if (skeleton[i] === open) depth++;
    else if (skeleton[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* The two rules                                                       */
/* ------------------------------------------------------------------ */

/** `outline-none` and friends, bare or behind any variant. */
const CLEARS_OUTLINE = /(^|:)outline-(none|hidden|0)$/;
/** Anything that only applies while the element is focused. */
const FOCUS_VARIANT = /(^|:)(focus|focus-visible|focus-within)(?:\/[\w-]+)?:/;
/** The pairing the paint sweep is about: an outline ring width under focus. */
const FOCUS_OUTLINE_WIDTH = /^focus-visible:outline-\d/;

/**
 * Class lists that pair `outline-none` with an outline focus ring — the shape
 * that resolves `outline-style: none` and paints nothing (B-arij-JJ5FdaHpX7d6).
 */
export function outlinePairingSites(
  source: string,
  file: string,
): ClassListSite[] {
  return adjacentClassLists(source, file).filter(
    (site) =>
      site.classes.includes("outline-none") &&
      site.classes.some((c) => FOCUS_OUTLINE_WIDTH.test(c)),
  );
}

/* ------------------------------------------------------------------ */
/* Is a focus utility an affordance, or only a focus utility?          */
/* ------------------------------------------------------------------ */

/**
 * A focus VARIANT is not a focus AFFORDANCE, and the difference is the whole
 * point of this rule. `focus-visible:outline-offset-2` positions a ring that
 * is not there; `focus-visible:ring-0` and `focus-visible:shadow-none` draw
 * nothing by definition; `focus-visible:outline-ring` names a colour for an
 * outline whose style `outline-none` already set to `none`. Accepting any
 * `focus-visible:*` as a replacement is exactly how the reported shape — clears
 * the outline, offers nothing — walks past this rule, and the paint sweep does
 * not catch these either: it only looks at lists declaring
 * `focus-visible:outline-<n>`, and none of them do.
 */
type Family =
  | "outline"
  | "ring"
  | "border"
  | "shadow"
  | "background"
  | "decoration"
  /** Something we do not model. Assumed to paint — see `declares`. */
  | "other";

type Effect = "paints" | "clears" | "inert";

interface Declaration {
  family: Family;
  effect: Effect;
}

/** A width: `-2`, `-[3px]`. Zero widths are rejected before this is reached. */
const WIDTH = /^(?:\d|\[)/;

/** Drop every variant prefix: `md:focus-visible:outline-2` → `outline-2`. */
function utility(token: string): string {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i++) {
    const char = token[i];
    if (char === "[" || char === "(") depth++;
    else if (char === "]" || char === ")") depth--;
    else if (char === ":" && depth === 0) cut = i;
  }
  return token.slice(cut + 1);
}

/**
 * Families for which the element declares a non-zero width ANYWHERE — base
 * classes included.
 *
 * A colour is an affordance only when there is something to colour in. On an
 * element that already draws a 1px border, `focus-visible:border-accent` is a
 * real, visible change; on one that does not, it paints nothing, because
 * Tailwind's preflight sets `border-width: 0` on every element. Same for a
 * ring colour without a ring width.
 */
function declaredWidths(classes: string[]): Set<Family> {
  const widths = new Set<Family>();
  for (const token of classes) {
    const u = utility(token).replace(/^-/, "");
    if (/^outline-(?:\d|\[)/.test(u) && u !== "outline-0") widths.add("outline");
    if (u === "ring" || (/^ring-(?:\d|\[)/.test(u) && u !== "ring-0")) {
      widths.add("ring");
    }
    if (
      u === "border" ||
      (/^border-(?:\d|\[)/.test(u) && u !== "border-0") ||
      /^border-[trblxyse]-(?:\d|\[)/.test(u)
    ) {
      widths.add("border");
    }
  }
  return widths;
}

/**
 * What one utility does to the pixels, given the widths the element declares.
 *
 * Deliberately generous at the end: a utility this function does not recognise
 * counts as painting. The rule's job is to catch elements that offer *nothing*,
 * and a guard that accused every affordance its author had not enumerated
 * would be worse than the hole it closes — the same false-accusation trade-off
 * that made this rule group by element rather than by adjacency.
 */
function declares(token: string, widths: Set<Family>): Declaration {
  const u = utility(token).replace(/^-/, "");

  if (u === "outline" || u.startsWith("outline-")) {
    const rest = u.slice("outline-".length);
    if (u === "outline") return { family: "outline", effect: "paints" };
    if (/^(?:none|hidden|0|transparent)$/.test(rest)) {
      return { family: "outline", effect: "clears" };
    }
    if (rest.startsWith("offset-")) return { family: "outline", effect: "inert" };
    if (/^(?:solid|dashed|dotted|double)$/.test(rest)) {
      return { family: "outline", effect: "paints" };
    }
    if (WIDTH.test(rest)) return { family: "outline", effect: "paints" };
    // A colour. `outline-none` set the style to `none`, so it needs a width
    // (and, per the paint sweep, a style) before it shows anything.
    return {
      family: "outline",
      effect: widths.has("outline") ? "paints" : "inert",
    };
  }

  if (u === "ring" || u.startsWith("ring-")) {
    const rest = u.slice("ring-".length);
    if (u === "ring") return { family: "ring", effect: "paints" };
    if (/^(?:0|transparent)$/.test(rest)) {
      return { family: "ring", effect: "clears" };
    }
    if (rest.startsWith("offset-") || rest === "inset") {
      return { family: "ring", effect: "inert" };
    }
    if (WIDTH.test(rest)) return { family: "ring", effect: "paints" };
    return { family: "ring", effect: widths.has("ring") ? "paints" : "inert" };
  }

  if (u === "border" || u.startsWith("border-")) {
    const rest = u.slice("border-".length);
    if (u === "border") return { family: "border", effect: "paints" };
    if (/^(?:0|transparent)$/.test(rest)) {
      return { family: "border", effect: "clears" };
    }
    if (WIDTH.test(rest) || /^[trblxyse]-(?:\d|\[)/.test(rest)) {
      return { family: "border", effect: "paints" };
    }
    return {
      family: "border",
      effect: widths.has("border") ? "paints" : "inert",
    };
  }

  if (u === "shadow" || u.startsWith("shadow-")) {
    if (u === "shadow-none") return { family: "shadow", effect: "clears" };
    return { family: "shadow", effect: "paints" };
  }

  if (u.startsWith("bg-")) {
    if (u === "bg-transparent") return { family: "background", effect: "clears" };
    return { family: "background", effect: "paints" };
  }

  if (u === "no-underline") return { family: "decoration", effect: "clears" };
  if (/^(?:underline|overline|line-through)$/.test(u)) {
    return { family: "decoration", effect: "paints" };
  }

  return { family: "other", effect: "paints" };
}

/** Does anything this element declares under focus actually draw? */
function paintsUnderFocus(classes: string[]): boolean {
  const widths = declaredWidths(classes);
  const paints = new Set<Family>();
  const cleared = new Set<Family>();

  for (const token of classes) {
    if (!FOCUS_VARIANT.test(token)) continue;
    const declaration = declares(token, widths);
    if (declaration.effect === "paints") paints.add(declaration.family);
    else if (declaration.effect === "clears") cleared.add(declaration.family);
  }

  // A family the same element cancels under focus is not an affordance:
  // `focus-visible:outline-2 focus-visible:outline-transparent` computes a
  // width and paints nothing.
  return [...paints].some((family) => !cleared.has(family));
}

/**
 * Elements that clear the outline and put NOTHING visible in its place — no
 * ring, no border, no outline, no focus affordance that draws (B-arij-203).
 *
 * Distinct from {@link outlinePairingSites} by construction: there is no ring
 * declaration to repair here, so `focus-visible:outline-solid` fixes nothing.
 * A keyboard user simply loses the browser's default ring and gets no
 * replacement.
 */
export function undeclaredFocusSites(
  source: string,
  file: string,
): ClassListSite[] {
  return elementClassLists(source, file).filter((site) => {
    if (!site.classes.some((c) => CLEARS_OUTLINE.test(c))) return false;
    return !paintsUnderFocus(site.classes);
  });
}

/* ------------------------------------------------------------------ */
/* Walking the tree                                                    */
/* ------------------------------------------------------------------ */

export const SOURCE_ROOTS = ["app", "components", "hooks"] as const;
/** Vendored shadcn: its focus affordance is `ring-*` (a box-shadow), not an outline. */
export const VENDORED = path.join("components", "ui");

export function sourceFiles(): string[] {
  return SOURCE_ROOTS.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .map((entry) => path.join(root, entry))
      .filter((file) => /\.tsx?$/.test(file) && !file.startsWith(VENDORED)),
  ).sort();
}

/** Run one of the rules over every scanned source file. */
export function scanSources(
  rule: (source: string, file: string) => ClassListSite[],
): ClassListSite[] {
  return sourceFiles().flatMap((file) =>
    rule(readFileSync(file, "utf8"), file),
  );
}

/** `file:line — the class list`, the shape every failure message wants. */
export function describeSite(site: ClassListSite): string {
  return `${site.file}:${site.line} — ${site.classes.join(" ")}`;
}
