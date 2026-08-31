import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Next 16 deprecated the `middleware` file convention and renamed it `proxy`.
 * Every dev start and every build printed:
 *
 *   ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
 *
 * The rename is not cosmetic here, because that root file *is* the localhost
 * boundary for `/api/*`. Next loads it by name, so a root file under a name
 * Next no longer recognises is not a weakened boundary — it is no boundary at
 * all, and the only signal is a warning nobody reads.
 *
 * These assertions are deliberately filesystem-level rather than behavioural:
 * `proxy-boundary.test.ts` proves the function still refuses the right
 * requests, but a correct function in a file Next never loads passes that test
 * and ships an open API. This file pins the wiring and the packaging.
 */

const projectRoot = path.resolve(__dirname, "..");

/**
 * Extensions Next accepts for the root proxy/middleware convention.
 *
 * Anchored at both ends: Next matches `proxy.ts`, not `proxy.anything.ts`.
 * An unanchored `/\.ts$/` would also swallow a future root `proxy.config.ts`
 * and fail this file for a filename Next never treats as the convention.
 */
const CONVENTION_EXTENSIONS = /^\.(ts|tsx|js|jsx|mjs|mts)$/;

function rootFilesNamed(base: string): string[] {
  return fs
    .readdirSync(projectRoot)
    .filter(
      (entry) =>
        entry.startsWith(`${base}.`) &&
        CONVENTION_EXTENSIONS.test(entry.slice(base.length))
    );
}

describe("root proxy file convention", () => {
  it("exposes the boundary under the name Next 16 loads", () => {
    expect(rootFilesNamed("proxy")).toEqual(["proxy.ts"]);
  });

  it("no longer carries a root file under the deprecated convention", () => {
    // The deprecation warning is emitted purely on the presence of a root
    // `middleware.*`, so leaving one behind reintroduces it even once
    // `proxy.ts` exists — and two files claiming the same job is worse than
    // either one alone.
    expect(rootFilesNamed("middleware")).toEqual([]);
  });

  it("ships the boundary file in the published package", () => {
    // `files` is an allowlist. A stale `middleware.ts` entry publishes an
    // `arij` tarball containing no proxy file at all — an app whose `/api/*`
    // is unguarded — while every check on this machine still passes.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
    ) as { files?: string[] };
    expect(pkg.files).toContain("proxy.ts");
    expect(pkg.files).not.toContain("middleware.ts");
  });
});
