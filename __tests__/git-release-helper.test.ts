import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import simpleGit from "simple-git";
import { createReleaseBranchAndCommitChangelog } from "@/lib/git/release";

const tempDirs: string[] = [];

async function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-release-"));
  tempDirs.push(dir);

  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.name", "Arij Test");
  await git.addConfig("user.email", "arij@example.com");

  fs.writeFileSync(path.join(dir, "README.md"), "# Test\n", "utf-8");
  await git.add(["README.md"]);
  await git.commit("chore: initial");
  await git.branch(["-M", "main"]);

  return { dir, git };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createReleaseBranchAndCommitChangelog", () => {
  const changelog = "# 1.2.3\n\n## Features\n- Added release helper\n\n## Bugfixes\n- None\n\n## Breaking Changes\n- None";

  it("creates release branch and commits CHANGELOG.md", async () => {
    const { dir, git } = await createTempRepo();

    const result = await createReleaseBranchAndCommitChangelog(
      dir,
      "1.2.3",
      changelog
    );

    expect(result.releaseBranch).toBe("release/v1.2.3");
    expect(result.changelogCommitted).toBe(true);
    expect(result.commitHash).toBeTruthy();

    await git.checkout("release/v1.2.3");
    const changelogFile = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8");
    expect(changelogFile).toContain("## Features");
    expect(changelogFile).toContain("## Bugfixes");
    expect(changelogFile).toContain("## Breaking Changes");
  });

  it("branches the release off the stored default branch when it exists", async () => {
    const { dir, git } = await createTempRepo();
    // A develop-default clone also carries local main; the stored
    // default_branch must win over the main preference.
    await git.checkoutLocalBranch("develop");
    fs.writeFileSync(path.join(dir, "develop-only.txt"), "develop\n", "utf-8");
    await git.add(["develop-only.txt"]);
    await git.commit("feat: develop-only change");

    const result = await createReleaseBranchAndCommitChangelog(
      dir,
      "1.0.0",
      changelog,
      { defaultBranch: "develop" }
    );

    expect(result.releaseBranch).toBe("release/v1.0.0");
    expect(result.changelogCommitted).toBe(true);

    await git.checkout("release/v1.0.0");
    // The release branch must carry develop's commit — if it had been cut
    // from main, this file would be missing.
    expect(fs.existsSync(path.join(dir, "develop-only.txt"))).toBe(true);
    // And the caller is checked back out onto the branch they were on.
    expect((await git.branch()).current).toBe("release/v1.0.0");
    await git.checkout("develop");
    expect((await git.branch()).current).toBe("develop");
  });

  it("falls back to the main preference when the stored default is missing", async () => {
    const { dir, git } = await createTempRepo();
    await git.checkoutLocalBranch("develop");
    fs.writeFileSync(path.join(dir, "develop-only.txt"), "develop\n", "utf-8");
    await git.add(["develop-only.txt"]);
    await git.commit("feat: develop-only change");

    // `trunk` does not exist locally: the release is cut from main, and
    // develop's commit stays out of it.
    const result = await createReleaseBranchAndCommitChangelog(
      dir,
      "2.0.0",
      changelog,
      { defaultBranch: "trunk" }
    );

    expect(result.releaseBranch).toBe("release/v2.0.0");

    await git.checkout("release/v2.0.0");
    expect(fs.existsSync(path.join(dir, "develop-only.txt"))).toBe(false);
  });
});
