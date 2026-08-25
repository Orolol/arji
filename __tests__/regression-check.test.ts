import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import simpleGit from "simple-git";
import {
  runRegressionCheck,
  fileMatchesAnyPattern,
  globToRegExp,
  buildRegressionCommand,
  type RegressionCommandOutcome,
} from "@/lib/verify/regression-check";
import { DEFAULT_TEST_FILE_PATTERNS } from "@/lib/verify/regression-constants";

/**
 * Real-repository coverage for the mechanical red → green regression gate
 * (lib/verify/regression-check.ts — the RoboBun rule for bug tickets).
 *
 * Each scenario builds a throwaway git repo whose committed `tools/probe.js`
 * plays the role of the targeted test runner: it exits 0 only under the
 * conditions named by the scenario. The branch adds a fix marker plus test
 * files; the check's red run copies ONLY the test files onto the merge-base,
 * so the marker is absent there — exactly how a real regression test fails
 * against unfixed source.
 */

const PROBE_SCRIPTS: Record<"redgreen" | "always-pass" | "always-fail", string> =
  {
    redgreen: [
      "const fs = require('fs');",
      "if (!fs.existsSync('src/fix.marker')) process.exit(1);",
      "process.exit(0);",
      "",
    ].join("\n"),
    "always-pass": ["process.exit(0);", ""].join("\n"),
    "always-fail": ["process.exit(1);", ""].join("\n"),
  };

let root: string;

function git(dir: string) {
  return simpleGit(dir);
}


async function initRepo(
  probe: keyof typeof PROBE_SCRIPTS
): Promise<{ repoPath: string; baseBranch: string }> {
  const repoPath = path.join(root, "repo");
  mkdirSync(repoPath);
  const g = git(repoPath);
  await g.init();
  await g.addConfig("user.email", "test@arij.local");
  await g.addConfig("user.name", "Arij Tests");
  mkdirSync(path.join(repoPath, "src"));
  writeFileSync(path.join(repoPath, "src/app.js"), "base\n");
  mkdirSync(path.join(repoPath, "tools"));
  writeFileSync(
    path.join(repoPath, "tools/probe.js"),
    PROBE_SCRIPTS[probe]
  );
  await g.add(["src/app.js", "tools/probe.js"]);
  await g.commit("base");
  // The default branch name depends on the local git configuration; never
  // assume master vs main.
  const baseBranch = (await g.branchLocal()).current;

  // Branch work happens on fix/bug; an extra base-branch commit after
  // branching forces the check to use the true merge-base rather than the
  // base tip.
  await g.checkoutLocalBranch("fix/bug");
  return { repoPath, baseBranch };
}

async function commitOnBranch(
  repoPath: string,
  files: Record<string, string>
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoPath, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const g = git(repoPath);
  await g.add(Object.keys(files));
  await g.commit("fix");
}

async function commitOnBase(
  repoPath: string,
  baseBranch: string
): Promise<void> {
  const g = git(repoPath);
  await g.checkout(baseBranch);
  writeFileSync(path.join(repoPath, "src/base-drift.txt"), "drift\n");
  await g.add(["src/base-drift.txt"]);
  await g.commit("base drift");
  await g.checkout("fix/bug");
}

function worktreeBase(repoPath: string): string {
  return path.join(repoPath, "..", ".arij-worktrees");
}

async function assertNoRedWorktreeLeft(repoPath: string): Promise<void> {
  // No temporary worktree survives: no regression-check-* entry on disk,
  // no administrative record left in git.
  const base = worktreeBase(repoPath);
  const leftovers = existsSync(base)
    ? readdirSync(base).filter((name) => name.startsWith("regression-check-"))
    : [];
  expect(leftovers).toEqual([]);
  const porcelain = await git(repoPath).raw(["worktree", "list", "--porcelain"]);
  expect(porcelain).not.toContain("regression-check-");
}

function ok(code = 0): RegressionCommandOutcome {
  return { code };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "arij-regression-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("fileMatchesAnyPattern / globToRegExp / buildRegressionCommand", () => {
  it("matches the default patterns across nesting depths", () => {
    expect(fileMatchesAnyPattern("src/a.test.ts", DEFAULT_TEST_FILE_PATTERNS)).toBe(true);
    expect(fileMatchesAnyPattern("a/b/c.spec.tsx", DEFAULT_TEST_FILE_PATTERNS)).toBe(true);
    expect(fileMatchesAnyPattern("__tests__/top.ts", DEFAULT_TEST_FILE_PATTERNS)).toBe(true);
    expect(fileMatchesAnyPattern("deep/__tests__/nested/x.ts", DEFAULT_TEST_FILE_PATTERNS)).toBe(true);
    expect(fileMatchesAnyPattern("src/index.ts", DEFAULT_TEST_FILE_PATTERNS)).toBe(false);
    expect(fileMatchesAnyPattern("src/tests.helper.ts", DEFAULT_TEST_FILE_PATTERNS)).toBe(false);
  });

  it("anchors patterns and treats ** as zero or more directories", () => {
    expect(globToRegExp("**/*.test.*").test("x.test.js")).toBe(true);
    expect(globToRegExp("**/__tests__/**").test("__tests__/a/b.ts")).toBe(true);
    expect(globToRegExp("**/__tests__/**").test("nope/__tests__x/c.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });

  it("quotes file paths when building the command", () => {
    expect(buildRegressionCommand("npx vitest run {files}", ["a.test.ts"])).toBe(
      "npx vitest run 'a.test.ts'"
    );
    expect(
      buildRegressionCommand("{files} && echo {files}", ["it's.test.ts"])
    ).toBe("'it'\\''s.test.ts' && echo 'it'\\''s.test.ts'");
  });
});

describe("runRegressionCheck — real repositories", () => {
  it("passes when the test is green on the branch and red on the merge-base", async () => {
    const { repoPath, baseBranch } = await initRepo("redgreen");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// reproduces the bug\n",
      "src/fix.marker": "fixed\n",
    });
    await commitOnBase(repoPath, baseBranch);

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result).toEqual({
      status: "passed",
      reason: null,
      testFiles: ["src/bug.test.js"],
      detail: null,
    });
    await assertNoRedWorktreeLeft(repoPath);
  }, 30_000);

  it("fails with no_test_in_diff when the diff carries no test file", async () => {
    const { repoPath } = await initRepo("redgreen");
    await commitOnBranch(repoPath, {
      "src/app.js": "changed without any test\n",
    });

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("no_test_in_diff");
    expect(result.testFiles).toEqual([]);
  }, 30_000);

  it("fails with test_passes_on_base when the test cannot fail without the fix", async () => {
    const { repoPath } = await initRepo("always-pass");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// does not actually reproduce anything\n",
    });

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("test_passes_on_base");
    expect(result.testFiles).toEqual(["src/bug.test.js"]);
    await assertNoRedWorktreeLeft(repoPath);
  }, 30_000);

  it("fails with test_fails_on_branch when green never happens", async () => {
    const { repoPath } = await initRepo("always-fail");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// still failing\n",
    });

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("test_fails_on_branch");
    expect(result.detail).toContain("1");
  }, 30_000);

  it("fails with command_error when the regression command cannot execute at all", async () => {
    const { repoPath } = await initRepo("redgreen");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// ok\n",
      "src/fix.marker": "fixed\n",
    });

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
      deps: {
        runCommand: async () => ({
          code: 1,
          failedToRun: true,
          output: "spawn node ENOENT",
        }),
      },
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("command_error");
    expect(result.detail).toContain("could not run");
  }, 30_000);

  it("destroys the temporary worktree even when an exception unwinds mid-red-run", async () => {
    const { repoPath } = await initRepo("redgreen");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// ok\n",
      "src/fix.marker": "fixed\n",
    });
    let calls = 0;

    await expect(
      runRegressionCheck({
        repoPath,
        commandTemplate: "node tools/probe.js {files}",
        deps: {
          runCommand: async (cwd) => {
            calls += 1;
            if (cwd !== repoPath) throw new Error("runner exploded during red run");
            return ok();
          },
        },
      })
    ).rejects.toThrow("runner exploded during red run");

    expect(calls).toBe(2);
    await assertNoRedWorktreeLeft(repoPath);
  }, 30_000);
});
