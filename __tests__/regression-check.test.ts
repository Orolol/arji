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
  looksLikeStartupFailure,
  type RegressionCommandOutcome,
} from "@/lib/verify/regression-check";
import { DEFAULT_TEST_FILE_PATTERNS } from "@/lib/verify/regression-constants";

/**
 * Real-repository coverage for the mechanical red → green regression gate
 * (lib/verify/regression-check.ts — the RoboBun rule for bug tickets).
 *
 * Each scenario builds a throwaway git repo whose committed `tools/probe.js`
 * plays the role of the targeted test runner: it exits 0 only under the
 * conditions named by the scenario.
 */

const PROBE_SCRIPTS: Record<
  "redgreen" | "always-pass" | "always-fail" | "envfail" | "envfail-always" |
    "contentcheck",
  string
> = {
  redgreen: [
    "const fs = require('fs');",
    "if (!fs.existsSync('src/fix.marker')) process.exit(1);",
    "process.exit(0);",
    "",
  ].join("\n"),
  "always-pass": ["process.exit(0);", ""].join("\n"),
  "always-fail": ["process.exit(1);", ""].join("\n"),
  // Fails WITHOUT the fix, printing the module-resolution text that the
  // merge-base genuinely produces when the branch adds the module the test
  // imports. A correct red, not an environment fault.
  envfail: [
    "const fs = require('fs');",
    "if (!fs.existsSync('src/fix.marker')) {",
    "  console.error(\"Error: Cannot find module 'left-pad'\");",
    "  process.exit(1);",
    "}",
    "process.exit(0);",
    "",
  ].join("\n"),
  // Fails ALWAYS with a missing-RUNNER signature: the green run must blame
  // the environment, not the agent's fix.
  "envfail-always": [
    "console.error(\"Error: Cannot find package 'vitest'\");",
    "process.exit(1);",
    "",
  ].join("\n"),
  // Red/green is driven by the CONTENT of the copied test file, proving
  // which version of it the red worktree actually received.
  contentcheck: [
    "const fs = require('fs');",
    "let c = '';",
    "try { c = fs.readFileSync(process.argv[2].replaceAll(\"'\", ''), 'utf8'); } catch {}",
    "if (!fs.existsSync('src/fix.marker') && !c.includes('WORKTREE')) process.exit(1);",
    "process.exit(0);",
    "",
  ].join("\n"),
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
    expect(result.detail).toContain("exit code 1");
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

  it("passes when the red run fails with a module-resolution error — the commonest real red", async () => {
    // The most ordinary bug fix there is adds a module and imports it from
    // the new test: on the merge-base that module does not exist, so the red
    // run says "Cannot find module". That IS the reproduction. Classifying it
    // as an environment fault rejected correct branches, and once
    // command_error became a terminal non-fix failure it killed the run
    // outright. The green run passing with the identical command is the
    // proof that the environment works.
    const { repoPath } = await initRepo("envfail");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// reproduces the bug\n",
      "src/fix.marker": "fixed\n",
    });

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("passed");
    expect(result.reason).toBeNull();
    expect(result.testFiles).toEqual(["src/bug.test.js"]);
  }, 30_000);

  it("reports command_error when a node project's worktree has no dependencies, whatever the output says", async () => {
    // Arij's createWorktree never installs dependencies, so this is the
    // DEFAULT state of a fresh epic worktree. The verdict must come from the
    // fact, not from whether the runner's phrasing happens to match a regex:
    // this probe's output looks like an ordinary assertion failure.
    const { repoPath } = await initRepo("always-fail");
    writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "fixture", private: true })
    );
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// reproduces the bug\n",
      "package.json": JSON.stringify({ name: "fixture", private: true }),
    });

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("command_error");
    expect(result.detail).toContain("no node_modules");
  }, 30_000);

  it("borrows the main checkout's node_modules so the green run has a runner", async () => {
    const { repoPath } = await initRepo("redgreen");
    writeFileSync(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "fixture", private: true })
    );
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// reproduces the bug\n",
      "src/fix.marker": "fixed\n",
      "package.json": JSON.stringify({ name: "fixture", private: true }),
    });

    // Dependencies live only in the main checkout, exactly as in production.
    const mainRepoPath = path.join(root, "main-checkout");
    mkdirSync(path.join(mainRepoPath, "node_modules"), { recursive: true });
    writeFileSync(path.join(mainRepoPath, "node_modules", ".keep"), "");

    const result = await runRegressionCheck({
      repoPath,
      mainRepoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(existsSync(path.join(repoPath, "node_modules"))).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.reason).toBeNull();
  }, 30_000);

  it("reports command_error — not no_test_in_diff — when there is no branch to diff", async () => {
    // An unborn HEAD is infrastructure, not a missing test. Routed to
    // no_test_in_diff it would dispatch a fix agent told to "write a test
    // that reproduces the bug" for a repository that has no commits at all.
    const repoPath = path.join(root, "empty-repo");
    mkdirSync(repoPath);
    const g = git(repoPath);
    await g.init();
    await g.addConfig("user.email", "test@arij.local");
    await g.addConfig("user.name", "Arij Tests");

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("command_error");
    expect(result.detail).toContain("no branch checked out");
  }, 30_000);

  it("warns in the report when the branch worktree has uncommitted tracked changes", async () => {
    // The green run reads the working tree while the red run reads committed
    // blobs. A half-staged fix would otherwise be certified silently.
    const { repoPath } = await initRepo("redgreen");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// reproduces the bug\n",
      "src/fix.marker": "fixed\n",
    });
    writeFileSync(path.join(repoPath, "src/app.js"), "uncommitted edit\n");

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("passed");
    expect(result.detail).toContain("uncommitted changes");
    expect(result.detail).toContain("src/app.js");
  }, 30_000);

  it("links the epic worktree's node_modules into the red worktree", async () => {
    const { repoPath } = await initRepo("redgreen");
    // Present on disk (gitignored in real projects), never committed.
    mkdirSync(path.join(repoPath, "node_modules"));
    writeFileSync(path.join(repoPath, "node_modules", ".keep"), "");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// reproduces the bug\n",
      "src/fix.marker": "fixed\n",
    });

    let redWorktreeHadNodeModules: boolean | null = null;
    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
      deps: {
        runCommand: async (cwd) => {
          if (cwd !== repoPath) {
            redWorktreeHadNodeModules = existsSync(path.join(cwd, "node_modules"));
            return { code: 1 }; // genuine red
          }
          return { code: 0 };
        },
      },
    });

    expect(result.status).toBe("passed");
    expect(redWorktreeHadNodeModules).toBe(true);
    await assertNoRedWorktreeLeft(repoPath);
  }, 30_000);

  it("creates the red worktree under worktreeRoot when one is given", async () => {
    const { repoPath } = await initRepo("redgreen");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// reproduces the bug\n",
      "src/fix.marker": "fixed\n",
    });
    const customRoot = path.join(root, "custom-worktrees");

    const result = await runRegressionCheck({
      repoPath,
      worktreeRoot: customRoot,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("passed");
    // Nothing leaked into the default sibling location, and the custom
    // root holds no leftover worktree (the root itself may persist).
    const sibling = path.join(repoPath, "..", ".arij-worktrees");
    expect(existsSync(sibling)).toBe(false);
    const leftovers = existsSync(customRoot)
      ? readdirSync(customRoot).filter((name) =>
          name.startsWith("regression-check-")
        )
      : [];
    expect(leftovers).toEqual([]);
  }, 30_000);

  // Deliberate exception to the no-real-timers rule: this exercises exec's
  // own kill-on-timeout against the platform clock — fake timers cannot
  // drive a child process. The child sleeps far longer than the timeout,
  // so wall time stays at ~the 500ms threshold.
  it("reports command_error when the command exceeds the configured timeout", async () => {
    const { repoPath } = await initRepo("redgreen");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// hangs instead of asserting\n",
      "tools/probe.js": [
        "setTimeout(() => process.exit(0), 30_000);",
        "",
      ].join("\n"),
    });

    const result = await runRegressionCheck({
      repoPath,
      commandTimeoutMs: 500,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("command_error");
    expect(result.detail).toContain("timed out");
  }, 30_000);

  it("reports command_error — not test_fails_on_branch — when the GREEN run fails environmentally", async () => {
    const { repoPath } = await initRepo("envfail-always");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// fine, but the runner cannot start\n",
    });

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("command_error");
    expect(result.detail).toContain(
      "green run failed for environmental reasons"
    );
  }, 30_000);
  it("copies the COMMITTED test blob into the red worktree, not the working tree", async () => {
    const { repoPath } = await initRepo("contentcheck");
    await commitOnBranch(repoPath, {
      "src/bug.test.js": "// COMMITTED version\n",
      "src/fix.marker": "fixed\n",
    });
    // Uncommitted agent edit: if the red run saw this, the probe would
    // pass on the base and the gate would wrongly report
    // test_passes_on_base instead of a genuine red.
    writeFileSync(path.join(repoPath, "src/bug.test.js"), "// WORKTREE\n");

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("passed");
    await assertNoRedWorktreeLeft(repoPath);
  }, 30_000);

  it("detects non-ASCII test paths despite core.quotePath", async () => {
    const { repoPath, baseBranch } = await initRepo("redgreen");
    await commitOnBranch(repoPath, {
      "src/caf\u00e9.test.js": "// reproduces the bug\n",
      "src/fix.marker": "fixed\n",
    });
    await commitOnBase(repoPath, baseBranch);

    const result = await runRegressionCheck({
      repoPath,
      commandTemplate: "node tools/probe.js {files}",
    });

    expect(result.status).toBe("passed");
    expect(result.testFiles).toEqual(["src/caf\u00e9.test.js"]);
    await assertNoRedWorktreeLeft(repoPath);
  }, 30_000);
});

describe("looksLikeStartupFailure", () => {
  it("matches module-resolution and runner-startup signatures", () => {
    expect(looksLikeStartupFailure("Error: Cannot find package 'vitest'")).toBe(true);
    expect(looksLikeStartupFailure("No test files found, exiting with code 1")).toBe(true);
    expect(looksLikeStartupFailure("sh: 1: vitest: not found")).toBe(true);
    expect(
      looksLikeStartupFailure("FAIL src/bug.test.js — expected 1 to be 2")
    ).toBe(false);
    // Project-source resolution is the EXPECTED red, never environmental.
    expect(
      looksLikeStartupFailure("Error: Cannot find module '../lib/normalize'")
    ).toBe(false);
    expect(looksLikeStartupFailure("ERR_MODULE_NOT_FOUND")).toBe(false);
    expect(
      looksLikeStartupFailure('Failed to resolve import "./normalize"')
    ).toBe(false);
    // An assertion message that merely contains "not found" is not a shell
    // reporting a missing program.
    expect(
      looksLikeStartupFailure("AssertionError: expected 'not found' to be 'ok'")
    ).toBe(false);
    expect(looksLikeStartupFailure(undefined)).toBe(false);
    expect(looksLikeStartupFailure("   ")).toBe(false);
  });
});
