/**
 * `lib/qa/aggregate.ts` must never reach the database — not even transitively.
 *
 * WHY THIS FILE EXISTS. The module's own header promises it "does not touch the
 * database: it is the contract shared by the route, the aggregate and the
 * hook", and `components/qa/QaScreen.tsx` imports it, so it is part of the
 * CLIENT bundle. Importing one constant from `lib/agent-sessions/lifecycle.ts`
 * — which imports `@/lib/db` — pulled `better-sqlite3` and `node:fs` into that
 * bundle and `/qa` stopped compiling in the browser entirely.
 *
 * NOTHING ELSE CATCHES IT. `tsc --noEmit` resolves the import happily, eslint
 * has no opinion, and every vitest file runs in Node where `better-sqlite3`
 * loads fine — the suite stayed green with the page broken. Only `next build`
 * or a real browser fails, and neither runs on every change.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It walks the real import graph from
 * the TypeScript source and fails on a server-only edge. It is evidence about
 * the module graph, not about the emitted bundle — `next build` remains the
 * only thing that proves what actually ships.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "..");

/** Modules that drag a native/Node-only dependency in behind them. */
const SERVER_ONLY = [
  "@/lib/db",
  "better-sqlite3",
  "node:fs",
  "node:path",
  "fs",
  "path",
];

/**
 * Every `@/…` or relative import of a file, parsed with the TypeScript
 * compiler rather than matched by regex — a scan that guesses at syntax
 * silently drops the sites it cannot see, which makes its coverage claim
 * worthless.
 */
function importsOf(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** `@/x` → `<root>/x`, `./x` → sibling. `null` for a bare package. */
function resolve(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Depth-first walk, returning the first server-only edge as a readable path. */
function findServerOnlyEdge(entry: string): string | null {
  const seen = new Set<string>();
  const walk = (file: string, trail: string[]): string | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      const here = [...trail, path.relative(ROOT, file)];
      if (SERVER_ONLY.includes(specifier)) {
        return [...here, specifier].join(" → ");
      }
      const next = resolve(specifier, file);
      if (!next) continue;
      const deeper = walk(next, here);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(entry, []);
}

describe("the pure half of the QA screen stays client-safe", () => {
  it.each([
    "lib/qa/aggregate.ts",
    // Its sibling contract module, and the leaf the liveness vocabulary was
    // moved into precisely so this stays true.
    "lib/qa/types.ts",
    "lib/agent-sessions/lifecycle-status.ts",
  ])("%s reaches nothing server-only", (relative) => {
    const edge = findServerOnlyEdge(path.join(ROOT, relative));

    expect(
      edge,
      `${relative} is in the client bundle (QaScreen imports it). This edge ` +
        `puts a Node-only module in the browser, which breaks the page at ` +
        `build time while tsc, eslint and the whole vitest suite stay green:\n  ${edge}`,
    ).toBeNull();
  });

  /**
   * Guards the guard: a walker that silently resolved nothing would report
   * "no server-only edge" for every entry, including one that obviously has
   * one. `lifecycle.ts` is the module the bad import actually came from.
   */
  it("finds the edge it is meant to find", () => {
    // `lifecycle.ts` is the module the bad import actually came from; it
    // reaches `fs` on its second line and `@/lib/db` on its fourth, so the
    // walk reports whichever it meets first — what matters is that it reports
    // one at all.
    const edge = findServerOnlyEdge(
      path.join(ROOT, "lib/agent-sessions/lifecycle.ts"),
    );

    expect(edge).not.toBeNull();
    expect(edge).toContain("lib/agent-sessions/lifecycle.ts");
  });
});
