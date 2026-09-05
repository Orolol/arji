/**
 * Find the Tailwind class lists in a source file, without being fooled by the
 * punctuation that surrounds them.
 *
 * WHY THIS IS NOT A REGEX. `__tests__/focus-ring-paints.test.tsx` used to pull
 * literals out with `/(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g` and treat comments as
 * a joinable separator. That regex has no idea what a comment is, so this
 * repository's own comment convention — naming a utility between backticks —
 * reads as a template literal:
 *
 *     "… outline-none",
 *     // the backticked name of a utility, in a comment
 *     "focus-visible:outline-2 …",
 *
 * The comment's two backticks open and close a phantom literal, the gap between
 * the real literals stops looking like whitespace, and the cluster is cut in
 * two. Neither half then carries both `outline-none` and the focus ring, so the
 * control drops out of the sweep with no assertion naming it — the failure
 * surfaced as `expected 39 to be greater than or equal to 40` (B-arij-206).
 * The same hole swallows an apostrophe in prose (`it's`) and a `//` inside a URL
 * string.
 *
 * So this module lexes instead: one pass over the source that knows the
 * difference between a string, a comment and a regex literal. Comments and
 * string *contents* are blanked out into a `skeleton` of the same length, which
 * keeps every offset valid for line numbers and makes brace/paren balancing
 * safe.
 *
 * It lives in `__tests__/helpers/` on purpose: vitest's include glob is
 * `**\/*.test.{ts,tsx,mjs}`, so nothing here is collected as a test.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
}

/** A `/` starts a regex only when the previous significant char cannot end an expression. */
const ENDS_EXPRESSION = /[\w)\]]/;

/**
 * One pass over a TS/TSX source, emitting its string and template literals and
 * blanking everything a class list can hide behind.
 */
export function lexSource(source: string): LexedSource {
  const literals: SourceLiteral[] = [];
  const skeleton = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < skeleton.length; k++) {
      if (skeleton[k] !== "\n") skeleton[k] = " ";
    }
  };

  let lastSignificant = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];

    if (char === "/" && source[i + 1] === "/") {
      let j = i;
      while (j < source.length && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }

    if (char === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const j = close === -1 ? source.length : close + 2;
      blank(i, j);
      i = j;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const quote = char as SourceLiteral["quote"];
      let j = i + 1;
      let value = "";
      while (j < source.length) {
        const inner = source[j];
        if (inner === "\\") {
          value += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (inner === quote) break;
        // `${…}` is code, not classes. Skip it, balancing braces, and leave a
        // space so `a-${x}b` never yields the token `a-b`.
        if (quote === "`" && inner === "$" && source[j + 1] === "{") {
          let depth = 1;
          let k = j + 2;
          while (k < source.length && depth > 0) {
            if (source[k] === "{") depth++;
            else if (source[k] === "}") depth--;
            k++;
          }
          value += " ";
          j = k;
          continue;
        }
        // An unterminated single/double-quoted literal is an apostrophe in a
        // JSX text node, not a string. Bail at the line end rather than
        // swallowing the rest of the file.
        if (quote !== "`" && inner === "\n") break;
        value += inner;
        j++;
      }
      const end = Math.min(j + 1, source.length);
      literals.push({ start: i, end, value, quote });
      blank(i + 1, end - 1);
      lastSignificant = quote;
      i = end;
      continue;
    }

    // A regex literal can carry quotes and slashes; blank its body so they are
    // not mistaken for a string. `/>` (JSX self-close) and division never
    // reach here or never terminate on the line, and fall through unchanged.
    if (char === "/" && !ENDS_EXPRESSION.test(lastSignificant)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < source.length) {
        const inner = source[j];
        if (inner === "\\") {
          j += 2;
          continue;
        }
        if (inner === "\n") break;
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed && j > i + 1) {
        blank(i + 1, j);
        lastSignificant = "/";
        i = j + 1;
        continue;
      }
    }

    if (!/\s/.test(char)) lastSignificant = char;
    i++;
  }

  return { literals, skeleton: skeleton.join("") };
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
  const { literals, skeleton } = lexSource(source);
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
      classes: classTokens(group.map((l) => l.value).join(" ")),
    }))
    .sort((a, b) => a.line - b.line);
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

/**
 * Elements that clear the outline and put NOTHING in its place — no ring, no
 * border, no outline, no focus variant of any kind (B-arij-203).
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
    return !site.classes.some(
      (c) => FOCUS_VARIANT.test(c) && !CLEARS_OUTLINE.test(c),
    );
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
