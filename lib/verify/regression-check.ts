import simpleGit, { type SimpleGit } from "simple-git";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { resolveBaseBranch } from "@/lib/git/base-branch";
import {
  DEFAULT_BUG_REGRESSION_COMMAND,
  DEFAULT_BUG_REGRESSION_TIMEOUT_MS,
  DEFAULT_TEST_FILE_PATTERNS,
  REGRESSION_COMMAND_FILE_PLACEHOLDER,
  REGRESSION_STARTUP_FAILURE_PATTERNS,
  REGRESSION_WORKTREE_PREFIX,
  type RegressionFailureReason,
} from "./regression-constants";

/**
 * Mechanical red → green regression gate for bug tickets (RoboBun rule).
 *
 * A bug-fix branch is only accepted when the branch diff carries at least
 * one test file, that test passes on the branch (green) and — proven by
 * copying ONLY the test files into a throwaway detached worktree cut at
 * the merge-base — fails without the fix (red). The red proof is what
 * distinguishes a real regression test from a test written after the fix
 * that never reproduced anything.
 *
 * Pure decision logic lives here; every git/exec side effect is either
 * injectable or wrapped so unit tests can drive real repositories. The
 * temporary worktree lives under `.arij-worktrees/` like every other agent
 * worktree (lib/git/manager.ts), with the `regression-check-` prefix, and
 * is destroyed in a `finally` — including when an exception unwinds.
 */

/* ------------------------------------------------------------------ */
/* Glob matching (dependency-free)                                     */
/* ------------------------------------------------------------------ */

/**
 * Compiles one glob pattern to a RegExp. Supported: `**` (any depth),
 * `*` (within a segment), `?` (one non-separator char). A double-star
 * followed by a slash also matches zero directories, so a
 * double-star/slash/double-star pattern around a directory name matches
 * both top-level and nested occurrences of that directory.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "");
  let source = "";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        // Collapse any further '*' run; `**/` optionally crosses segments.
        while (normalized[i + 1] === "*") i++;
        if (normalized[i + 1] === "/" ) {
          source += "(?:[^/]*/)*";
          i++;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when a repo-relative path matches ANY of the glob patterns. */
export function fileMatchesAnyPattern(
  filePath: string,
  patterns: readonly string[]
): boolean {
  const normalized = filePath.split(path.sep).join("/").replace(/^\.\//, "");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface RegressionCheckResult {
  status: "passed" | "failed";
  /** Normalized failure reason; null exactly when status is "passed". */
  reason: RegressionFailureReason | null;
  /** Test files detected in the branch diff (repo-relative). */
  testFiles: string[];
  /**
   * Human-readable detail for the report/UI: the failing command's output
   * tail, or why detection stopped. Null when nothing worth adding.
   */
  detail: string | null;
}

export interface RegressionCommandOutcome {
  code: number;
  /**
   * True when the command could not be executed at all (spawn failure,
   * missing binary) as opposed to running and exiting non-zero — reported
   * as `command_error` rather than a red/green verdict.
   */
  failedToRun?: boolean;
  /** Combined stdout+stderr tail, for the failure detail. */
  output?: string;
}

/** Side effects the check needs; injectable for tests. */
export interface RegressionCheckDeps {
  /** Runs the regression command in a directory; resolves its exit code. */
  runCommand(
    cwd: string,
    command: string
  ): Promise<RegressionCommandOutcome>;
}

export interface RunRegressionCheckInput {
/**
 * The epic worktree holding the bug-fix branch checked out — the green
 * run happens here.
 */
  repoPath: string;
  /**
   * Where the temporary red worktree is created. Callers pass the managed
   * root (`worktreesRootFor(project.gitRepoPath)`) so a worktree-backed
   * `repoPath` does not nest `.arij-worktrees` inside `.arij-worktrees`.
   * Default: `<repoPath parent>/.arij-worktrees`, i.e. the layout the unit
   * tests see when handed a plain repository.
   */
  worktreeRoot?: string | null;
  /** Branch carrying the fix; defaults to the worktree's current branch. */
  headBranch?: string | null;
  /** Base to diff against; resolved through resolveBaseBranch when null. */
  baseBranch?: string | null;
  patterns?: readonly string[];
  commandTemplate?: string;
  /** Kill threshold for the green/red commands (default ten minutes). */
  commandTimeoutMs?: number;
  deps?: Partial<RegressionCheckDeps>;
}
/** Shell-quotes one path for the regression command line. */
function quotePath(filePath: string): string {
  return `'${filePath.replaceAll("'", "'\\''")}'`;
}

/** Substitutes every `{files}` occurrence with the quoted file list. */
export function buildRegressionCommand(
  template: string,
  testFiles: readonly string[]
): string {
  const list = testFiles.map(quotePath).join(" ");
  return template.split(REGRESSION_COMMAND_FILE_PLACEHOLDER).join(list);
}


export function defaultRunCommand(
  cwd: string,
  command: string,
  timeoutMs: number = DEFAULT_BUG_REGRESSION_TIMEOUT_MS
): Promise<RegressionCommandOutcome> {
  const { promise, resolve } = Promise.withResolvers<RegressionCommandOutcome>();
  exec(
    command,
    {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      // Verbose test reporters and failure dumps exceed the 1 MiB default
      // routinely; a truncated kill would masquerade as a verdict.
      maxBuffer: 16 * 1024 * 1024,
    },
    (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") {
        // No numeric exit code: either the process was killed by a signal
        // (timeout → SIGTERM, error.signal set) or it never started at all
        // (ENOENT, EACCES). Neither produces a red/green verdict.
        const timedOut = error.killed === true || typeof error.signal === "string";
        resolve({
          code: 1,
          failedToRun: true,
          output: timedOut
            ? `the regression command timed out after ${Math.round(timeoutMs / 1000)}s`
            : `${error.message}`,
        });
        return;
      }
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, output: `${stdout ?? ""}${stderr ?? ""}`.trim() });
    }
  );
  return promise;
}

/** True when a failed run's output matches an environmental-startup signature. */
export function looksLikeStartupFailure(
  output: string | undefined
): boolean {
  const trimmed = output?.trim() ?? "";
  if (!trimmed) return false;
  return REGRESSION_STARTUP_FAILURE_PATTERNS.some((pattern) =>
    pattern.test(trimmed)
  );
}

function outputTail(output: string | undefined): string | null {
  const trimmed = output?.trim() ?? "";
  if (!trimmed) return null;
  return trimmed.length > 2000 ? `${trimmed.slice(-2000)}\n…` : trimmed;
}

/* ------------------------------------------------------------------ */
/* Red → green check                                                   */
/* ------------------------------------------------------------------ */

/**
 * Resolves the merge-base of base and head in the repo backing `repoPath`,
 * then runs the whole red → green cycle. Check outcomes — including every
 * degraded case — are reported as failed results, never thrown. True
 * infrastructure errors (unresolvable refs, vanished files) MAY still
 * throw; cleanup of the temporary worktree runs either way.
 */
export async function runRegressionCheck(
  input: RunRegressionCheckInput
): Promise<RegressionCheckResult> {
  const runCommand = input.deps?.runCommand
    ? input.deps.runCommand
    : (cwd: string, command: string) =>
        defaultRunCommand(
          cwd,
          command,
          input.commandTimeoutMs ?? DEFAULT_BUG_REGRESSION_TIMEOUT_MS
        );
  const patterns = input.patterns ?? DEFAULT_TEST_FILE_PATTERNS;
  const template = input.commandTemplate ?? DEFAULT_BUG_REGRESSION_COMMAND;
  const git = simpleGit(input.repoPath);

  // --- Branch + merge-base ------------------------------------------
  const branches = await git.branchLocal();
  const head = input.headBranch || branches.current;
  if (!head) {
    return failed("no_test_in_diff", [], "no branch checked out");
  }
  // Same resolution createWorktree/mergeWorktree use (projects.default_branch
  // preferred, git-asked fallback).
  const base = await resolveBaseBranch(git, branches.all, {
    preferred: input.baseBranch ?? null,
  });
  const mergeBase = (await git.raw(["merge-base", base, head])).trim();

  // --- Test files added/modified on the branch ----------------------
  const diffNames = (
    await git.raw(["diff", "--name-only", "--diff-filter=ACMR", `${mergeBase}..${head}`])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const testFiles = diffNames.filter((name) =>
    fileMatchesAnyPattern(name, patterns)
  );
  if (testFiles.length === 0) {
    return failed(
      "no_test_in_diff",
      [],
      "the branch diff contains no file matching the project's test patterns"
    );
  }

  // --- GREEN: same command must pass in the epic worktree ------------
  const greenCommand = buildRegressionCommand(template, testFiles);
  const green = await runCommand(input.repoPath, greenCommand);
  if (green.failedToRun) {
    return failed(
      "command_error",
      testFiles,
      `the regression command could not run: ${outputTail(green.output) ?? "no output"}`
    );
  }
  if (green.code !== 0) {
    return failed(
      "test_fails_on_branch",
      testFiles,
      outputTail(green.output) ?? `exit code ${green.code}`
    );
  }

  // --- RED: copy ONLY the test files onto the merge-base -------------
  const worktreeBase =
    input.worktreeRoot ?? path.join(input.repoPath, "..", ".arij-worktrees");
  fs.mkdirSync(worktreeBase, { recursive: true });
  const tempPath = path.join(
    worktreeBase,
    `${REGRESSION_WORKTREE_PREFIX}${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
  );

  try {
    await git.raw([
      "worktree",
      "add",
      "--detach",
      tempPath,
      mergeBase,
    ]);

    // The merge-base checkout has no installed dependencies (gitignored),
    // so without this link the command fails for environmental reasons and
    // a spurious red would masquerade as proof of reproduction.
    const nodeModules = path.join(input.repoPath, "node_modules");
    if (fs.existsSync(nodeModules)) {
      try {
        fs.symlinkSync(nodeModules, path.join(tempPath, "node_modules"), "dir");
      } catch {
        // A missing link degrades to the startup-failure check below.
      }
    }

    for (const relPath of testFiles) {
      const destination = path.join(tempPath, relPath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(input.repoPath, relPath), destination);
    }

    const red = await runCommand(tempPath, greenCommand);
    if (red.failedToRun) {
      return failed(
        "command_error",
        testFiles,
        `the regression command could not run: ${outputTail(red.output) ?? "no output"}`
      );
    }
    if (red.code === 0) {
      return failed(
        "test_passes_on_base",
        testFiles,
        "the test command already passes on the merge-base — the test does not reproduce the bug"
      );
    }
    // A non-zero exit that smells like the runner or an import never came
    // up is not evidence of reproduction — do not count it as red.
    if (looksLikeStartupFailure(red.output)) {
      return failed(
        "command_error",
        testFiles,
        `the red run failed for environmental reasons rather than because of the test: ${
          outputTail(red.output) ?? "no output"
        }`
      );
    }
    return { status: "passed", reason: null, testFiles, detail: null };
  } finally {
    await removeRedWorktree(git, tempPath);
  }
}

function failed(
  reason: RegressionFailureReason,
  testFiles: string[],
  detail: string | null
): RegressionCheckResult {
  return { status: "failed", reason, testFiles, detail };
}

/**
 * Destroys the temporary worktree no matter how the check ended. Both
 * removal paths are best-effort: `git worktree remove --force` first
 * (drops the administrative record), then a plain recursive delete as a
 * belt-and-braces for a half-created directory git never registered.
 */
async function removeRedWorktree(
  git: SimpleGit,
  tempPath: string
): Promise<void> {
  try {
    await git.raw(["worktree", "remove", "--force", tempPath]);
  } catch {
    // Unregistered (or already gone): the rm below still cleans the disk.
  }
  try {
    fs.rmSync(tempPath, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Disk-level cleanup raced something; the orphan detector in
    // lib/git/worktrees.ts recognizes the leftover record either way.
  }
}
