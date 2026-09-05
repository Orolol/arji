/**
 * `data/.gitignore` denies by default.
 *
 * data/ holds runtime state only — the SQLite database, session logs and
 * artifacts, uploads, dated snapshots. The file used to enumerate those
 * artifacts, so each new runtime directory leaked into `git status` until a
 * human noticed: `backups/` sat there at 472 MB of board snapshot and comment
 * archive, one `git add -A` from a half-gigabyte commit of ticket, session and
 * prompt content.
 *
 * The load-bearing case below is `ignores an artifact directory nobody
 * enumerated`: it is the one that fails against the old enumerating file and
 * passes against the denylist.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const DATA_DIRNAME = "data";
const REAL_ROOT_GITIGNORE = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf-8");
const REAL_DATA_GITIGNORE = fs.readFileSync(
  path.join(REPO_ROOT, DATA_DIRNAME, ".gitignore"),
  "utf-8"
);

let testRepoDir: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: testRepoDir, encoding: "utf-8" });
}

/**
 * Whether git actually ignores the path.
 *
 * `check-ignore -v` cannot answer this: it prints *negated* patterns as
 * matches too and exits 0 for them, so `!.gitignore` reads as "ignored" under
 * `-v` while the plain form correctly exits 1. Ask without `-v` for the
 * boolean, and use `matchingRule` only to name the rule that did it.
 */
function isIgnored(relativePath: string): boolean {
  try {
    git(["check-ignore", "-q", "--no-index", relativePath]);
    return true;
  } catch {
    return false;
  }
}

/** The last ignore rule matching the path, negations included; null if none. */
function matchingRule(relativePath: string): string | null {
  try {
    return git(["check-ignore", "-v", "--no-index", relativePath]).trim();
  } catch {
    return null;
  }
}

/** Materializes `data/<...segments>` with a file inside, returns its path. */
function materialize(...segments: string[]): string {
  const target = path.join(testRepoDir, DATA_DIRNAME, ...segments);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "runtime artifact\n");
  return target;
}

/**
 * Working-tree entries under `data/`, if any. `-uall` expands untracked
 * directories: without it git collapses them to a bare `data/` and the
 * assertion cannot say which files actually leak.
 */
function statusUnderDataDir(): string[] {
  return git(["status", "--porcelain", "-uall"])
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((entry) => entry === `${DATA_DIRNAME}/` || entry.startsWith(`${DATA_DIRNAME}/`));
}

beforeEach(() => {
  testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-data-gitignore-test-"));
  execFileSync("git", ["init"], { cwd: testRepoDir, encoding: "utf-8" });
  fs.writeFileSync(path.join(testRepoDir, ".gitignore"), REAL_ROOT_GITIGNORE);
  fs.mkdirSync(path.join(testRepoDir, DATA_DIRNAME), { recursive: true });
  fs.writeFileSync(
    path.join(testRepoDir, DATA_DIRNAME, ".gitignore"),
    REAL_DATA_GITIGNORE
  );
});

afterEach(() => {
  if (testRepoDir && fs.existsSync(testRepoDir)) {
    fs.rmSync(testRepoDir, { recursive: true, force: true });
  }
});

describe("data/.gitignore — deny by default", () => {
  it("is a denylist rather than an enumeration of known artifacts", () => {
    const rules = REAL_DATA_GITIGNORE.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(rules).toEqual(["*", "!.gitignore"]);
  });

  it("ignores an artifact directory nobody enumerated", () => {
    // The regression: an artifact kind that did not exist when the ignore file
    // was written. Under the old enumerating file this path was untracked and
    // stageable — which is how data/backups/ came to sit in `git status`.
    materialize("verify-reports-2027", "run-1.json");

    expect(isIgnored(`${DATA_DIRNAME}/verify-reports-2027/run-1.json`)).toBe(true);
    expect(matchingRule(`${DATA_DIRNAME}/verify-reports-2027/run-1.json`)).toContain("*");
    expect(statusUnderDataDir()).toEqual([`${DATA_DIRNAME}/.gitignore`]);
  });

  it("ignores data/backups/, the directory the enumeration missed", () => {
    materialize("backups", "arij-board-snapshot.db");
    materialize("backups", "comment-echo-archive-2026-08-26.json");

    expect(isIgnored(`${DATA_DIRNAME}/backups`)).toBe(true);
    expect(isIgnored(`${DATA_DIRNAME}/backups/arij-board-snapshot.db`)).toBe(true);
  });

  it("still ignores the artifacts the old enumeration listed", () => {
    for (const artifact of [
      "arij.db",
      "arij.db-wal",
      "arij.db-shm",
      "e2e.db",
      "arij.db.backup-2026-08-26",
      "arij.db.audit37-backup",
      "mcp-user-global.json",
      "sessions/abc123/artifacts/proof.png",
      "logs/session.log",
      "uploads/project-1/screenshot.png",
      "migrations/0040_example.sql",
    ]) {
      materialize(...artifact.split("/"));
      expect(isIgnored(`${DATA_DIRNAME}/${artifact}`)).toBe(true);
    }

    expect(statusUnderDataDir()).toEqual([`${DATA_DIRNAME}/.gitignore`]);
  });

  it("keeps data/.gitignore itself trackable", () => {
    // `*` would swallow the ignore file too; the `!.gitignore` negation pinned
    // by the shape test above is what keeps the rule in version control.
    expect(isIgnored(`${DATA_DIRNAME}/.gitignore`)).toBe(false);
  });

  it("does not reach outside data/", () => {
    fs.mkdirSync(path.join(testRepoDir, "lib", "db"), { recursive: true });
    fs.writeFileSync(path.join(testRepoDir, "lib", "db", "schema.ts"), "// schema\n");
    fs.mkdirSync(path.join(testRepoDir, "lib", "db", "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(testRepoDir, "lib", "db", "migrations", "0001_init.sql"),
      "-- init\n"
    );

    expect(isIgnored("lib/db/schema.ts")).toBe(false);
    // The hand-written migrations are source; only data/migrations/ is runtime.
    expect(isIgnored("lib/db/migrations/0001_init.sql")).toBe(false);
  });
});

describe("Tailwind source scoping is independent of data/'s ignore state", () => {
  // The superseded data/.gitignore warned that un-ignoring a DB snapshot would
  // put it in Tailwind's source scan, where stray text yields bogus utility
  // candidates and fails the CSS build. That coupling ended with f1d1d22:
  // globals.css disables automatic detection and names its own directories, so
  // inverting data/ to a denylist cannot move the scan either way.
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "app", "globals.css"), "utf-8");

  it("disables Tailwind's automatic (gitignore-driven) source detection", () => {
    expect(globalsCss).toMatch(/@import\s+"tailwindcss"\s+source\(none\)/);
  });

  it("scans only the directories that hold markup, never data/", () => {
    const sources = [...globalsCss.matchAll(/@source\s+"([^"]+)"/g)].map((m) => m[1]);

    expect(sources).toEqual(["../app", "../components", "../hooks", "../lib"]);
    expect(sources.some((source) => source.includes("data"))).toBe(false);
  });
});

describe(".gitignore — build info", () => {
  it("ignores tsconfig.tsbuildinfo through the root *.tsbuildinfo rule", () => {
    fs.writeFileSync(path.join(testRepoDir, "tsconfig.tsbuildinfo"), "{}\n");

    expect(isIgnored("tsconfig.tsbuildinfo")).toBe(true);
    expect(matchingRule("tsconfig.tsbuildinfo")).toContain("*.tsbuildinfo");
    expect(git(["status", "--porcelain"])).not.toContain("tsbuildinfo");
  });
});
