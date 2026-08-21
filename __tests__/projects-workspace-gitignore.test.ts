/**
 * The `/projects` .gitignore rule: cloned repositories — and the worktrees
 * Arij creates for them — must never show up in Arij's own git history when
 * dogfooding the app on its own checkout.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECTS_ROOT_DIRNAME } from "@/lib/projects/workspace-constants";

const REPO_ROOT = process.cwd();
const CLONE_DIRNAME = "owner-repo";
const REAL_GITIGNORE = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf-8");

let testRepoDir: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: testRepoDir, encoding: "utf-8" });
}

/** `git check-ignore -v <p>`; null when the path is not ignored (exit 1). */
function checkIgnore(relativePath: string): string | null {
  try {
    return git(["check-ignore", "-v", "--no-index", relativePath]).trim();
  } catch {
    return null;
  }
}

beforeEach(() => {
  testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-gitignore-test-"));
  execFileSync("git", ["init"], { cwd: testRepoDir, encoding: "utf-8" });
  fs.writeFileSync(path.join(testRepoDir, ".gitignore"), REAL_GITIGNORE);
  fs.mkdirSync(path.join(testRepoDir, "app", "projects"), { recursive: true });
  fs.writeFileSync(path.join(testRepoDir, "app", "projects", "page.tsx"), "// page\n");
  fs.mkdirSync(path.join(testRepoDir, "lib", "projects"), { recursive: true });
  fs.writeFileSync(path.join(testRepoDir, "lib", "projects", "workspace.ts"), "// workspace\n");
});

afterEach(() => {
  if (testRepoDir && fs.existsSync(testRepoDir)) {
    fs.rmSync(testRepoDir, { recursive: true, force: true });
  }
});

/** Materializes `<testRepoDir>/projects/...` and returns the absolute root path. */
function materialize(...segments: string[]): string {
  const root = path.join(testRepoDir, DEFAULT_PROJECTS_ROOT_DIRNAME);
  const target = path.join(root, ...segments);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "README.md"), "# clone\n");
  return root;
}

/** Working-tree entries under the root `projects/` directory, if any. */
function statusUnderProjectsRoot(): string[] {
  return git(["status", "--porcelain"])
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((entry) =>
      entry === `${DEFAULT_PROJECTS_ROOT_DIRNAME}/` ||
      entry.startsWith(`${DEFAULT_PROJECTS_ROOT_DIRNAME}/`)
    );
}

describe(".gitignore — app-managed clone root", () => {
  it("contains the anchored /projects rule", () => {
    expect(REAL_GITIGNORE.split("\n").map((l) => l.trim())).toContain("/projects");
  });

  it("ignores a clone destination", () => {
    expect(checkIgnore(`${DEFAULT_PROJECTS_ROOT_DIRNAME}/${CLONE_DIRNAME}`)).toContain(
      "/projects"
    );
  });

  it("ignores the worktrees created for a cloned project", () => {
    // lib/git/manager.ts places worktrees at path.join(repoPath, "..",
    // ".arij-worktrees") — for a clone at <root>/<owner>-<repo> that is
    // <root>/.arij-worktrees, covered by the same rule.
    const clonePath = path.join(
      testRepoDir,
      DEFAULT_PROJECTS_ROOT_DIRNAME,
      CLONE_DIRNAME
    );
    const worktreeBase = path.join(clonePath, "..", ".arij-worktrees");

    expect(path.resolve(worktreeBase)).toBe(
      path.join(testRepoDir, DEFAULT_PROJECTS_ROOT_DIRNAME, ".arij-worktrees")
    );
    expect(
      checkIgnore(path.relative(testRepoDir, path.join(worktreeBase, "epic-branch")))
    ).toContain("/projects");
  });

  it("leaves app/projects and lib/projects tracked (the rule is anchored)", () => {
    expect(checkIgnore("app/projects")).toBeNull();
    expect(checkIgnore("lib/projects")).toBeNull();
    expect(checkIgnore("lib/projects/workspace.ts")).toBeNull();
  });

  it("keeps git status clean after a clone lands in the default root", () => {
    materialize(CLONE_DIRNAME);

    expect(statusUnderProjectsRoot()).toEqual([]);
  });

  it("keeps git status clean after an epic build adds a worktree", () => {
    materialize(CLONE_DIRNAME);
    materialize(".arij-worktrees", "feature-epic-abc123");

    expect(statusUnderProjectsRoot()).toEqual([]);
  });
});
