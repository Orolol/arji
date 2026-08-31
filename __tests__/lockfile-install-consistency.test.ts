/**
 * A `node_modules` that lags `package-lock.json` does not fail loudly — it
 * fails *misleadingly*, as type errors in files the current diff never
 * touched. `lib/git/clone.ts` is the recurring victim: the `unsafe: {
 * allowUnsafeAskPass: true }` option it passes to `simpleGit()` is TS2769 on
 * simple-git 3.30 and clean on the pinned 3.36, because the flag only exists
 * once `SimpleGitOptions["unsafe"]` picks up `VulnerabilityCategoryFlags`
 * from `@simple-git/argv-parser`. Sessions have repeatedly triaged that ghost
 * as a real regression in `clone.ts`.
 *
 * These assertions turn "is the install honest?" into a test failure that
 * names the cause and the fix, and pin the CLAUDE.md guidance that tells the
 * next session to check before triaging.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf-8");
}

function installedVersion(name: string): string | null {
  try {
    return JSON.parse(read("node_modules", name, "package.json")).version;
  } catch {
    return null;
  }
}

const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));

function lockedVersion(name: string): string | undefined {
  return lock.packages[`node_modules/${name}`]?.version;
}

const directDependencies = Object.keys({
  ...pkg.dependencies,
  ...pkg.devDependencies,
}).sort();

describe("the install matches the lockfile", () => {
  it("resolves every direct dependency to its locked version", () => {
    const drift = directDependencies.flatMap((name) => {
      const locked = lockedVersion(name);
      const installed = installedVersion(name);
      if (locked && installed === locked) return [];
      return [`${name}: installed ${installed ?? "(absent)"}, locked ${locked ?? "(absent)"}`];
    });

    // Not a style nit: a stale install relocates type errors into untouched
    // files, so every measurement taken on it is suspect. Run `npm ci`.
    expect(drift, `stale node_modules — run \`npm ci\`:\n${drift.join("\n")}`).toEqual([]);
  });

  it("pins next and simple-git, the two that drift in hardlinked worktrees", () => {
    expect(installedVersion("next")).toBe(lockedVersion("next"));
    expect(installedVersion("simple-git")).toBe(lockedVersion("simple-git"));
  });
});

describe("simple-git supplies the option lib/git/clone.ts relies on", () => {
  it("declares allowUnsafeAskPass, so clone.ts typechecks", () => {
    // Asserted against the shipped typings rather than a version string: the
    // version is the proxy, this is the thing clone.ts actually needs.
    const flags = read(
      "node_modules",
      "@simple-git",
      "argv-parser",
      "dist/src/vulnerabilities/vulnerability.types.d.ts"
    );
    expect(flags).toContain("allowUnsafeAskPass");

    const options = read(
      "node_modules",
      "simple-git",
      "dist/src/lib/types/index.d.ts"
    );
    expect(options).toMatch(/unsafe:\s*Partial<VulnerabilityCategoryFlags/);
  });
});

describe("CLAUDE.md warns about the stale-install trap", () => {
  const claudeMd = read("CLAUDE.md");

  it("has a section about phantom type errors from a stale install", () => {
    expect(claudeMd).toMatch(/phantom/i);
    expect(claudeMd).toMatch(/stale/i);
    expect(claudeMd).toContain("package-lock.json");
  });

  it("names the check to run and the recurring example", () => {
    expect(claudeMd).toContain("npm ci");
    // The file that keeps getting triaged as broken when it is not.
    expect(claudeMd).toContain("lib/git/clone.ts");
  });

  it("says the phantom errors land in files the diff never touched", () => {
    expect(claudeMd).toMatch(/never touched|did not touch|untouched/i);
  });
});
