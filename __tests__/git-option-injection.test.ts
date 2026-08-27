import { describe, expect, it, vi, beforeEach, type Mock } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const gitMock = vi.hoisted(() => {
  const git: Record<string, Mock> = {};
  git.raw = vi.fn().mockResolvedValue("");
  git.env = vi.fn(() => git);
  git.branchLocal = vi.fn().mockResolvedValue({ all: ["main", "feature/valid"], current: "main" });
  git.checkIsRepo = vi.fn().mockResolvedValue(true);
  git.getRemotes = vi.fn().mockResolvedValue([{ name: "origin", refs: { fetch: "https://github.com/owner/repo.git" } }]);
  git.revparse = vi.fn().mockResolvedValue("HEAD");
  git.pull = vi.fn().mockResolvedValue({ summary: {} });
  git.push = vi.fn().mockResolvedValue({});
  git.fetch = vi.fn().mockResolvedValue({});
  git.status = vi.fn().mockResolvedValue({ files: [], staged: [], not_added: [], conflicted: [], modified: [] });
  return git;
});

vi.mock("simple-git", () => ({
  default: vi.fn(() => gitMock),
  CheckRepoActions: { IS_REPO_ROOT: "root" },
}));

import { cloneRepository, CloneError, nonInteractiveEnv } from "@/lib/git/clone";
import {
  createWorktree,
  attachWorktree,
  mergeWorktree,
  captureMergeCheckpoint,
} from "@/lib/git/manager";
import { getWorktreeDiff } from "@/lib/git/diff";
import {
  fetchGitRemote,
  pullGitBranchWithConflictSupport,
  pushGitBranch,
  getBranchSyncStatus,
} from "@/lib/git/remote";

describe("git option-injection defense", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("nonInteractiveEnv", () => {
    it("disables interactive credential prompts while stripping all 18 dangerous environment variables", () => {
      const dangerousKeys = [
        "GIT_EDITOR",
        "GIT_SEQUENCE_EDITOR",
        "GIT_PAGER",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_CONFIG",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_COUNT",
        "GIT_EXEC_PATH",
        "GIT_EXTERNAL_DIFF",
        "GIT_PROXY_COMMAND",
        "GIT_TEMPLATE_DIR",
        "EDITOR",
        "PAGER",
        "PREFIX",
      ];

      // Temporarily populate process.env with dangerous keys
      const originalEnv = { ...process.env };
      for (const key of dangerousKeys) {
        process.env[key] = "malicious-value";
      }

      try {
        const env = nonInteractiveEnv();

        // Must retain prompt short-circuiting keys
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(env.GIT_ASKPASS).toBe("");
        expect(env.SSH_ASKPASS).toBe("");
        expect(env.GCM_INTERACTIVE).toBe("never");

        // Must strip all 18 dangerous keys
        for (const key of dangerousKeys) {
          expect(env[key]).toBeUndefined();
        }
      } finally {
        for (const key of dangerousKeys) {
          if (originalEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = originalEnv[key];
          }
        }
      }
    });
  });

  describe("cloneRepository", () => {
    it("rejects a clone URL starting with a dash or flag prefix", async () => {
      await expect(
        cloneRepository({
          cloneUrl: "--upload-pack=touch /tmp/pwn",
          dest: "/tmp/dest",
        })
      ).rejects.toThrow(CloneError);

      await expect(
        cloneRepository({
          cloneUrl: "-o",
          dest: "/tmp/dest",
        })
      ).rejects.toThrow(CloneError);

      expect(gitMock.raw).not.toHaveBeenCalled();
    });

    it("rejects a branch name starting with a dash or flag prefix", async () => {
      await expect(
        cloneRepository({
          cloneUrl: "https://github.com/owner/repo.git",
          dest: "/tmp/dest",
          branch: "--config=core.editor=touch /tmp/pwn",
        })
      ).rejects.toThrow(CloneError);

      expect(gitMock.raw).not.toHaveBeenCalled();
    });
  });

  describe("worktree management", () => {
    it("rejects branch names beginning with -- in attachWorktree", async () => {
      await expect(
        attachWorktree("/fake/repo", "--config=core.editor=calc")
      ).rejects.toThrow("Invalid branch name");

      expect(gitMock.raw).not.toHaveBeenCalled();
    });

    it("rejects branch names beginning with - in attachWorktree", async () => {
      await expect(
        attachWorktree("/fake/repo", "-b")
      ).rejects.toThrow("Invalid branch name");

      expect(gitMock.raw).not.toHaveBeenCalled();
    });

    it("rejects branch names beginning with -- in mergeWorktree", async () => {
      const result = await mergeWorktree(
        "/fake/repo",
        "--upload-pack=evil",
        "/fake/worktree"
      );

      expect(result.merged).toBe(false);
      expect(result.reason).toBe("error");
      expect(result.error).toContain("Invalid branch name");
      expect(gitMock.raw).not.toHaveBeenCalled();
    });

    it("rejects flag-like branch names in captureMergeCheckpoint", async () => {
      expect(await captureMergeCheckpoint("/fake/repo", "--evil")).toBeNull();
      expect(await captureMergeCheckpoint("/fake/repo", "  -b")).toBeNull();
      expect(gitMock.revparse).not.toHaveBeenCalled();
    });

    it("creates worktrees safely without letting branch name land in option position", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arij-test-repo-"));
      try {
        gitMock.branchLocal.mockResolvedValueOnce({
          all: ["main", "feature/epic-123-test"],
          current: "main",
        });

        await createWorktree(tmp, "123", "test");

        const rawCalls = gitMock.raw.mock.calls.map((c) => c[0]);
        const worktreeCall = rawCalls.find((args) => args[0] === "worktree" && args[1] === "add");
        expect(worktreeCall).toBeDefined();
        expect(worktreeCall[worktreeCall.length - 1]).toBe("feature/epic-123-test");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe("diff and sync", () => {
    it("rejects base branch names beginning with -- in getWorktreeDiff", async () => {
      await expect(
        getWorktreeDiff("/fake/worktree", "--output=/tmp/pwn")
      ).rejects.toThrow("Invalid base branch");

      expect(gitMock.raw).not.toHaveBeenCalled();
    });

    it("rejects remote names beginning with -- or leading space in fetchGitRemote", async () => {
      await expect(
        fetchGitRemote("/fake/repo", "--upload-pack=evil")
      ).rejects.toThrow("Invalid remote name");

      await expect(
        fetchGitRemote("/fake/repo", "   --upload-pack=evil")
      ).rejects.toThrow("Invalid remote name");

      expect(gitMock.fetch).not.toHaveBeenCalled();
    });

    it("rejects branch names beginning with -- in pullGitBranchWithConflictSupport", async () => {
      await expect(
        pullGitBranchWithConflictSupport("/fake/repo", "--upload-pack=evil")
      ).rejects.toThrow("Invalid branch name");

      expect(gitMock.pull).not.toHaveBeenCalled();
    });

    it("rejects remote names beginning with -- or leading space in pullGitBranchWithConflictSupport", async () => {
      await expect(
        pullGitBranchWithConflictSupport("/fake/repo", "main", "--upload-pack=evil")
      ).rejects.toThrow("Invalid remote name");

      await expect(
        pullGitBranchWithConflictSupport("/fake/repo", "main", "   --upload-pack=evil")
      ).rejects.toThrow("Invalid remote name");

      expect(gitMock.pull).not.toHaveBeenCalled();
    });

    it("rejects branch names beginning with -- in pushGitBranch", async () => {
      await expect(
        pushGitBranch("/fake/repo", "--receive-pack=evil")
      ).rejects.toThrow("Invalid branch name");

      expect(gitMock.push).not.toHaveBeenCalled();
    });

    it("rejects remote names beginning with -- or leading space in pushGitBranch", async () => {
      await expect(
        pushGitBranch("/fake/repo", "main", "   --receive-pack=evil")
      ).rejects.toThrow("Invalid remote name");

      expect(gitMock.push).not.toHaveBeenCalled();
    });

    it("rejects branch names beginning with -- in getBranchSyncStatus", async () => {
      await expect(
        getBranchSyncStatus("/fake/repo", "--output=/tmp/pwn")
      ).rejects.toThrow("Invalid branch name");

      expect(gitMock.raw).not.toHaveBeenCalled();
    });

    it("rejects remote names beginning with -- or leading space in getBranchSyncStatus", async () => {
      await expect(
        getBranchSyncStatus("/fake/repo", "main", "  -o")
      ).rejects.toThrow("Invalid remote name");

      expect(gitMock.raw).not.toHaveBeenCalled();
    });
  });
});
