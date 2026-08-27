/**
 * lib/git/manager.ts merge primitives, with simple-git mocked.
 *
 * The behaviours pinned here all exist because an UNATTENDED caller reacts to
 * them: it dispatches a conflict-resolution agent, or rolls `main` back, or
 * gives up — and each of those is the wrong move for the other cases.
 *
 *   - error handling is split at the point of no return: once `git merge`
 *     succeeds, `main` HAS changed, so a failure while reading the commit
 *     hash or deleting the branch must not be reported as "not merged";
 *   - failures carry a structured `reason`, because "conflict" is the only
 *     one an agent can fix;
 *   - `attachWorktree` re-attaches to an EXACT branch name, not one derived
 *     from a title that may have been edited since;
 *   - `captureMergeCheckpoint` / `rollbackMerge` make an unwanted merge
 *     undoable.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const gitState = vi.hoisted(() => ({
  localBranches: ["main", "feature/epic-1"] as string[],
  mergeImpl: null as null | (() => Promise<unknown>),
  logImpl: null as null | (() => Promise<unknown>),
  deleteBranchImpl: null as null | (() => Promise<unknown>),
  calls: [] as string[],
  revparse: new Map<string, string>(),
}));

const gitApi = vi.hoisted(() => ({
  branchLocal: vi.fn(),
  raw: vi.fn(),
  checkout: vi.fn(),
  merge: vi.fn(),
  log: vi.fn(),
  deleteLocalBranch: vi.fn(),
  revparse: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("simple-git", () => ({
  default: vi.fn(() => gitApi),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  },
}));

const { mergeWorktree, attachWorktree, captureMergeCheckpoint, rollbackMerge } =
  await import("@/lib/git/manager");

beforeEach(() => {
  gitState.localBranches = ["main", "feature/epic-1"];
  gitState.calls = [];
  gitState.revparse = new Map([
    ["main", "main-sha\n"],
    ["feature/epic-1", "branch-sha\n"],
  ]);

  gitApi.branchLocal.mockReset().mockImplementation(async () => ({
    all: gitState.localBranches,
  }));
  gitApi.raw.mockReset().mockImplementation(async (args: string[]) => {
    gitState.calls.push(`raw:${args.join(" ")}`);
    return "";
  });
  gitApi.checkout.mockReset().mockImplementation(async (branch: string) => {
    gitState.calls.push(`checkout:${branch}`);
  });
  gitApi.merge.mockReset().mockImplementation(async (args: string[]) => {
    gitState.calls.push(`merge:${args.join(" ")}`);
    return "";
  });
  gitApi.log
    .mockReset()
    .mockImplementation(async () => ({ latest: { hash: "merge-sha" } }));
  gitApi.deleteLocalBranch.mockReset().mockImplementation(async () => ({}));
  gitApi.revparse
    .mockReset()
    .mockImplementation(async (args: string[]) => gitState.revparse.get(args[0]) ?? "");
  gitApi.reset.mockReset().mockImplementation(async (args: string[]) => {
    gitState.calls.push(`reset:${args.join(" ")}`);
  });
});

describe("mergeWorktree", () => {
  it("merges and reports the commit hash", async () => {
    const result = await mergeWorktree("/repo", "feature/epic-1");

    expect(result).toEqual({ merged: true, commitHash: "merge-sha" });
    expect(gitState.calls).toContain(
      "merge:feature/epic-1 --no-ff -m Merge feature/epic-1"
    );
    expect(gitApi.deleteLocalBranch).toHaveBeenCalledWith(
      "feature/epic-1",
      true
    );
  });

  it("reports a MISSING BRANCH distinctly — no agent can fix that", async () => {
    gitState.localBranches = ["main"];

    const result = await mergeWorktree("/repo", "feature/gone");

    expect(result).toMatchObject({ merged: false, reason: "branch-missing" });
    expect(gitApi.merge).not.toHaveBeenCalled();
  });

  it("reports post-preflight merge failure as error and aborts the merge", async () => {
    gitApi.merge.mockImplementation(async (args: string[]) => {
      gitState.calls.push(`merge:${args.join(" ")}`);
      if (args[0] === "--abort") return "";
      throw new Error("error: Your local changes to the following files would be overwritten by merge");
    });

    const result = await mergeWorktree("/repo", "feature/epic-1");

    expect(result).toMatchObject({ merged: false, reason: "error" });
    expect(result.error).toContain("overwritten by merge");
    expect(gitState.calls).toContain("merge:--abort");
  });
  it("detects merge conflict via merge-tree preflight without checking out main or running merge", async () => {
    gitApi.raw.mockImplementation(async (args: string[]) => {
      gitState.calls.push(`raw:${args.join(" ")}`);
      if (args.includes("merge-tree")) {
        return "5fb6ee3208d15ae0c6bd2258737c801419ebf5ca\nlib/a.ts\nlib/b.ts\n\nAuto-merging lib/a.ts\nCONFLICT (content): Merge conflict in lib/a.ts\n";
      }
      return "";
    });

    const result = await mergeWorktree("/repo", "feature/epic-1");

    expect(result).toMatchObject({
      merged: false,
      reason: "conflict",
      conflictFiles: ["lib/a.ts", "lib/b.ts"],
    });
    expect(result.error).toContain("CONFLICT");
    expect(gitApi.checkout).not.toHaveBeenCalled();
    expect(gitApi.merge).not.toHaveBeenCalled();
  });

  it("reports a pre-merge failure as an error, not a conflict", async () => {
    gitApi.checkout.mockRejectedValue(new Error("local changes would be lost"));

    const result = await mergeWorktree("/repo", "feature/epic-1");

    expect(result).toMatchObject({ merged: false, reason: "error" });
    expect(gitApi.merge).not.toHaveBeenCalled();
  });

  it("reports a vanished repo directory as an error instead of throwing", async () => {
    // simple-git throws SYNCHRONOUSLY from its factory when the repo path no
    // longer exists — that must come back through the merged:false contract,
    // not escape as an exception for every caller to special-case.
    const simpleGitFactory = vi.mocked((await import("simple-git")).default);
    simpleGitFactory.mockImplementationOnce(() => {
      throw new Error(
        "Cannot use simple-git on a directory that does not exist"
      );
    });

    const result = await mergeWorktree("/gone", "feature/epic-1");

    expect(result).toMatchObject({ merged: false, reason: "error" });
    expect(result.error).toContain("does not exist");
    expect(gitApi.merge).not.toHaveBeenCalled();
  });

  it("still reports MERGED when the commit-hash lookup fails afterwards", async () => {
    gitApi.log.mockRejectedValue(new Error("log exploded"));

    const result = await mergeWorktree("/repo", "feature/epic-1");

    // `main` has already changed. Saying "not merged" here would send an
    // unattended caller off to dispatch a conflict agent for a merge that
    // already landed.
    expect(result).toMatchObject({ merged: true });
    expect(result.commitHash).toBeUndefined();
  });

  it("still reports MERGED when deleting the branch fails afterwards", async () => {
    gitApi.deleteLocalBranch.mockRejectedValue(new Error("branch is checked out"));

    const result = await mergeWorktree("/repo", "feature/epic-1");

    expect(result).toEqual({ merged: true, commitHash: "merge-sha" });
    // And crucially: no `--abort` was attempted on a merge that succeeded.
    expect(gitState.calls).not.toContain("merge:--abort");
  });
});

describe("attachWorktree", () => {
  it("attaches to the exact branch name it is given", async () => {
    const result = await attachWorktree("/repo", "feature/epic-1");

    expect(result.branchName).toBe("feature/epic-1");
    expect(gitState.calls).toContain(
      `raw:worktree add ${result.worktreePath} feature/epic-1`
    );
    // Never derives a name — a title edited since the branch was cut would
    // otherwise silently start work on a fresh branch off main.
    expect(result.worktreePath).toContain("feature-epic-1");
  });

  it("refuses when the branch does not exist", async () => {
    gitState.localBranches = ["main"];
    await expect(attachWorktree("/repo", "feature/gone")).rejects.toThrow(
      "Branch feature/gone not found"
    );
  });
});

describe("merge checkpoint + rollback", () => {
  it("captures where main and the branch point", async () => {
    const checkpoint = await captureMergeCheckpoint("/repo", "feature/epic-1");

    expect(checkpoint).toEqual({
      mainBranch: "main",
      mainHead: "main-sha",
      branchName: "feature/epic-1",
      branchHead: "branch-sha",
    });
  });

  it("returns null rather than throwing when the state cannot be read", async () => {
    gitApi.revparse.mockRejectedValue(new Error("not a repository"));
    expect(await captureMergeCheckpoint("/repo", "feature/epic-1")).toBeNull();
  });

  it("resets main and restores the deleted branch", async () => {
    // Post-merge state: the branch is gone, main moved on.
    gitState.localBranches = ["main"];

    const result = await rollbackMerge("/repo", {
      mainBranch: "main",
      mainHead: "main-sha",
      branchName: "feature/epic-1",
      branchHead: "branch-sha",
    });

    expect(result).toEqual({ restored: true });
    expect(gitState.calls).toContain("checkout:main");
    expect(gitState.calls).toContain("reset:--hard main-sha");
    expect(gitState.calls).toContain("raw:branch feature/epic-1 branch-sha");
  });

  it("does not recreate a branch that still exists", async () => {
    const result = await rollbackMerge("/repo", {
      mainBranch: "main",
      mainHead: "main-sha",
      branchName: "feature/epic-1",
      branchHead: "branch-sha",
    });

    expect(result).toEqual({ restored: true });
    expect(gitState.calls).not.toContain("raw:branch feature/epic-1 branch-sha");
  });

  it("reports a failed rollback instead of throwing", async () => {
    gitApi.reset.mockRejectedValue(new Error("reset refused"));

    const result = await rollbackMerge("/repo", {
      mainBranch: "main",
      mainHead: "main-sha",
      branchName: "feature/epic-1",
      branchHead: "branch-sha",
    });

    expect(result).toMatchObject({ restored: false });
    expect(result.error).toContain("reset refused");
  });
});
