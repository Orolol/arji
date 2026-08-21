import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import simpleGit, { type SimpleGit } from "simple-git";
import { mergeWorktree } from "@/lib/git/manager";

/**
 * The conflict-marker guard in `mergeWorktree`, against REAL git.
 *
 * The bug this pins down: a branch whose COMMITTED tree still contains
 * leftover conflict markers (a resolution that committed the markers instead
 * of resolving them) merges into main perfectly cleanly — git has no
 * conflict to report, so nothing downstream ever notices. The guard must
 * refuse such a branch BEFORE the merge, with a reason distinct from
 * "conflict" so unattended callers park it instead of dispatching a
 * conflict-resolution agent at a merge that is not conflicted.
 *
 * Real repositories rather than mocks, because the guard's behaviour hangs
 * on real `git grep` semantics: the exit-1-means-no-matches convention, the
 * `ref:path` output shape, and binary-file handling.
 */

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Repo with one commit on `main`, ready for a feature branch. */
async function createRepo(): Promise<{ dir: string; git: SimpleGit }> {
  const dir = tempDir("arij-marker-guard-");
  const git = simpleGit(dir);

  await git.init();
  await git.addConfig("user.name", "Arij Test");
  await git.addConfig("user.email", "arij@example.com");
  await git.addConfig("commit.gpgsign", "false");

  fs.writeFileSync(path.join(dir, "README.md"), "# Test\n", "utf-8");
  await git.add(["README.md"]);
  await git.commit("chore: initial");
  await git.branch(["-M", "main"]);

  return { dir, git };
}

/** Cuts `branchName` off main, commits `files` to it, returns to main. */
async function branchWithFiles(
  dir: string,
  git: SimpleGit,
  branchName: string,
  files: Record<string, string | Buffer>
): Promise<void> {
  await git.checkoutLocalBranch(branchName);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  await git.add(Object.keys(files));
  await git.commit("feat: branch work");
  await git.checkout("main");
}

/** A file body exactly as git leaves it when markers were never resolved. */
const MARKER_LADEN = [
  "export function greet() {",
  "<<<<<<< HEAD",
  '  return "hello";',
  "=======",
  '  return "bonjour";',
  ">>>>>>> feature/epic-2-translate",
  "}",
  "",
].join("\n");

describe("mergeWorktree conflict-marker guard", () => {
  it("refuses a branch that committed leftover conflict markers, touching nothing", async () => {
    const { dir, git } = await createRepo();
    await branchWithFiles(dir, git, "feature/epic-1-bad", {
      "greet.ts": MARKER_LADEN,
      "clean.ts": "export const ok = true;\n",
    });
    const mainHeadBefore = (await git.revparse(["main"])).trim();

    const result = await mergeWorktree(dir, "feature/epic-1-bad");

    expect(result.merged).toBe(false);
    expect(result.reason).toBe("conflict-markers");
    // The message names the offending file — and ONLY it — so a human can
    // go fix exactly that, without chasing clean files.
    expect(result.error).toContain("greet.ts");
    expect(result.error).not.toContain("clean.ts");

    // Nothing happened: main did not move, the branch survived (it holds the
    // only copy of the work), and no half-started merge was left behind.
    expect((await git.revparse(["main"])).trim()).toBe(mainHeadBefore);
    expect((await git.branchLocal()).all).toContain("feature/epic-1-bad");
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect((await git.status()).isClean()).toBe(true);
  });

  it("still merges a clean branch, binary files included", async () => {
    const { dir, git } = await createRepo();
    // The binary blob proves `git grep` over the branch tree does not choke
    // on non-text content the branch happens to add.
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x3c, 0x3c, 0x0a]);
    await branchWithFiles(dir, git, "feature/epic-2-clean", {
      "feature.ts": "export const feature = 1;\n",
      "logo.png": binary,
    });

    const result = await mergeWorktree(dir, "feature/epic-2-clean");

    expect(result.merged).toBe(true);
    expect(result.commitHash).toBeDefined();
    // The work actually landed on main.
    expect(fs.readFileSync(path.join(dir, "feature.ts"), "utf-8")).toContain(
      "feature = 1"
    );
  });

  it("does not flag files that merely MENTION markers mid-line", async () => {
    const { dir, git } = await createRepo();
    // Mirrors lib/claude/prompt-builder.ts, which legitimately talks about
    // conflict markers inside a template string — never at line start.
    await branchWithFiles(dir, git, "feature/epic-3-prose", {
      "prompt.ts": [
        "export const instructions = `",
        "2. For each conflicted file, resolve the conflict markers (\\`<<<<<<<\\`, \\`=======\\`, \\`>>>>>>>\\`) by preserving both sides.",
        "`;",
        "",
      ].join("\n"),
    });

    const result = await mergeWorktree(dir, "feature/epic-3-prose");

    expect(result.merged).toBe(true);
  });

  it("does not flag a file with only one half of the marker pair", async () => {
    const { dir, git } = await createRepo();
    // Only the closing marker at line start — e.g. a test fixture or a doc
    // heading. Both halves are required before a file counts as unresolved.
    await branchWithFiles(dir, git, "feature/epic-4-half", {
      "notes.md": ">>>>>>> this heading only looks like a marker\n",
    });

    const result = await mergeWorktree(dir, "feature/epic-4-half");

    expect(result.merged).toBe(true);
  });

  it("catches the longer markers a conflict-marker-size attribute produces", async () => {
    const { dir, git } = await createRepo();
    // With `*.ts conflict-marker-size=15` in .gitattributes, git writes
    // 15-character marker runs — a fixed 7-character pattern waves them
    // straight through.
    await branchWithFiles(dir, git, "feature/epic-5-long", {
      "long.ts": [
        "export function greet() {",
        "<<<<<<<<<<<<<<< HEAD",
        '  return "hello";',
        "===============",
        '  return "bonjour";',
        ">>>>>>>>>>>>>>> feature/epic-5-long",
        "}",
        "",
      ].join("\n"),
    });

    const result = await mergeWorktree(dir, "feature/epic-5-long");

    expect(result.merged).toBe(false);
    expect(result.reason).toBe("conflict-markers");
    expect(result.error).toContain("long.ts");
  });

  it("catches markers in non-ASCII filenames despite quotepath encoding", async () => {
    const { dir, git } = await createRepo();
    // With core.quotepath at its default, `git diff --name-only` reports
    // this file as "caf\303\251.ts" (octal-escaped, quoted) — a pathspec
    // that matches nothing, so the guard would silently skip the file.
    await branchWithFiles(dir, git, "feature/epic-6-accent", {
      "café.ts": MARKER_LADEN,
    });

    const result = await mergeWorktree(dir, "feature/epic-6-accent");

    expect(result.merged).toBe(false);
    expect(result.reason).toBe("conflict-markers");
    expect(result.error).toContain("café.ts");
  });

  it("survives a diff wider than one grep batch and still finds the marker file", async () => {
    const { dir, git } = await createRepo();
    // More changed files than GREP_PATHSPEC_BATCH (500), so the pathspec
    // list must be chunked across several `git grep` spawns — one giant
    // argv would die with E2BIG before git even starts. The single dirty
    // file sits past the first batch boundary to prove later batches run.
    fs.mkdirSync(path.join(dir, "bulk"));
    const files: Record<string, string> = {};
    for (let i = 0; i < 520; i++) {
      files[`bulk/file-${String(i).padStart(4, "0")}.ts`] =
        `export const v${i} = ${i};\n`;
    }
    files["bulk/file-0510-dirty.ts"] = MARKER_LADEN;
    await branchWithFiles(dir, git, "feature/epic-7-wide", files);

    const result = await mergeWorktree(dir, "feature/epic-7-wide");

    expect(result.merged).toBe(false);
    expect(result.reason).toBe("conflict-markers");
    expect(result.error).toContain("bulk/file-0510-dirty.ts");
    expect(result.error).not.toContain("file-0000");
  });
});
