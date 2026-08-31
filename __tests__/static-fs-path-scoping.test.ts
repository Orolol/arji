import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Turbopack traces filesystem access statically. A `path.join(process.cwd(),
 * x)` whose next segment it cannot evaluate is an unscoped access: the build
 * assumes anything under the project may be read and copies *every* source
 * file — plus `public/` — into the server output bundle, warning
 * "Dynamic filesystem access causes tracing of the whole project".
 *
 * One such call is enough to pull the whole project in, so this is a
 * project-wide rule rather than a per-file one: the literal prefix must be
 * visible at the join itself. `path.join(process.cwd(), "data", "uploads",
 * projectId)` is fine; `path.join(process.cwd(), storedRelativePath)` and
 * `path.join(process.cwd(), uploadsDirectoryFor(projectId))` are not — a
 * function call is opaque to the analyzer even when its body is literal.
 *
 * This is a source scan, not a build: it catches the `process.cwd()` family,
 * which is where every occurrence in this repo has come from. The
 * authoritative check remains `next build` reporting zero such warnings.
 */
describe("process.cwd() joins are statically scoped", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const scannedRoots = ["app", "lib"];

  /** Source with comments blanked, so doc prose cannot read as a call. */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
  }

  function tsFilesUnder(directory: string): string[] {
    const found: string[] = [];

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        found.push(...tsFilesUnder(full));
      } else if (/\.tsx?$/.test(entry.name)) {
        found.push(full);
      }
    }

    return found;
  }

  /**
   * `path.join(process.cwd(), <segment>` occurrences whose `<segment>` is not
   * a plain string literal. `[^,)]*` stops at the first comma, so the segment
   * captured is exactly the one Turbopack has to evaluate.
   */
  function unscopedJoins(source: string): string[] {
    const pattern = /path\.(?:join|resolve)\(\s*process\.cwd\(\)\s*,\s*([^,)]*)/g;
    const offenders: string[] = [];

    for (const match of source.matchAll(pattern)) {
      const segment = match[1].trim();
      const isStringLiteral = /^"[^"]*"$|^'[^']*'$|^`[^`${]*`$/.test(segment);
      if (!isStringLiteral) offenders.push(match[0].trim());
    }

    return offenders;
  }

  it("scans a plausible number of source files", () => {
    const files = scannedRoots.flatMap((root) =>
      tsFilesUnder(path.join(repoRoot, root))
    );

    expect(files.length).toBeGreaterThan(200);
  });

  it("recognises the two shapes it exists to tell apart", () => {
    expect(
      unscopedJoins(`path.join(process.cwd(), "data", "sessions", sessionId)`)
    ).toEqual([]);
    expect(
      unscopedJoins(`path.join(process.cwd(), attachment.filePath)`)
    ).toHaveLength(1);
    expect(
      unscopedJoins(`path.join(process.cwd(), uploadsDirectoryFor(projectId))`)
    ).toHaveLength(1);
    expect(
      unscopedJoins(`path.join(process.cwd(), ...SHIM_SEGMENTS)`)
    ).toHaveLength(1);
    expect(
      unscopedJoins(`path.resolve(process.cwd(), relativePath)`)
    ).toHaveLength(1);
  });

  it("finds no unscoped join in app/ or lib/", () => {
    const offenders: string[] = [];

    for (const root of scannedRoots) {
      for (const file of tsFilesUnder(path.join(repoRoot, root))) {
        const source = withoutComments(fs.readFileSync(file, "utf8"));
        for (const call of unscopedJoins(source)) {
          offenders.push(`${path.relative(repoRoot, file)}: ${call}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
