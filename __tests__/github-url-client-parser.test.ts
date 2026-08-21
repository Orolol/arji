import { describe, expect, it } from "vitest";
import { parseGitHubRepoInput } from "@/lib/git/github-url";

describe("parseGitHubRepoInput (client-safe)", () => {
  it.each([
    "https://github.com/Orolol/arij",
    "https://github.com/Orolol/arij.git",
    "https://www.github.com/Orolol/arij",
    "http://github.com/Orolol/arij",
    "github.com/Orolol/arij",
    "www.github.com/Orolol/arij",
    "git@github.com:Orolol/arij.git",
    "ssh://git@github.com/Orolol/arij.git",
    "git://github.com/Orolol/arij.git",
    "Orolol/arij",
    "  https://github.com/Orolol/arij/  ",
  ])("accepts %s", (input) => {
    expect(parseGitHubRepoInput(input)).toEqual({
      owner: "Orolol",
      repo: "arij",
      ownerRepo: "Orolol/arij",
      cloneUrl: "https://github.com/Orolol/arij.git",
    });
  });

  it.each([
    "https://github.com/Orolol/arij/tree/main",
    "https://github.com/Orolol/arij/blob/main/README.md",
    "https://github.com/Orolol/arij/pull/12",
    "https://github.com/Orolol/arij?tab=readme-ov-file",
    "https://github.com/Orolol/arij#install",
  ])("strips the browser suffix from %s", (input) => {
    expect(parseGitHubRepoInput(input)?.ownerRepo).toBe("Orolol/arij");
  });

  it("always normalises the clone url to https", () => {
    expect(parseGitHubRepoInput("git@github.com:Orolol/arij.git")?.cloneUrl).toBe(
      "https://github.com/Orolol/arij.git"
    );
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["https://gitlab.com/owner/repo", "another host"],
    ["https://github.com/onlyowner", "no repo segment"],
    ["owner", "shorthand without a repo"],
    ["a/b/c", "three segments"],
    ["../../etc/passwd", "traversal"],
    ["https://github.com/../evil", "traversal in a url"],
    ["https://github.com/owner/..", "traversal as the repo"],
    ["https://github.com/./repo", "dot as the owner"],
    ["-oProxyCommand/repo", "owner git would read as an option"],
    ["owner/-repo", "repo git would read as an option"],
    ["owner/re po", "whitespace"],
    ["owner/re\0po", "NUL byte"],
  ])("rejects %s (%s)", (input) => {
    expect(parseGitHubRepoInput(input)).toBeNull();
  });

  it("does not mistake the host for an owner when a github url fails to parse", () => {
    expect(parseGitHubRepoInput("https://github.com/onlyowner")).toBeNull();
    expect(parseGitHubRepoInput("github.com/onlyowner")).toBeNull();
  });

  it("keeps dots, dashes and underscores that GitHub allows", () => {
    expect(parseGitHubRepoInput("my-org_1/my.repo_v2")).toEqual(
      expect.objectContaining({ owner: "my-org_1", repo: "my.repo_v2" })
    );
  });

  it("rejects consecutive dots anywhere in a segment", () => {
    // Matches the server-side posture (validatePath in lib/validation/path.ts
    // and __tests__/github-repo-input-parsing.test.ts): anything that even
    // looks like a traversal component never reaches the filesystem layer.
    expect(parseGitHubRepoInput("owner/repo..v2")).toBeNull();
    expect(parseGitHubRepoInput("https://github.com/owner/repo..v2")).toBeNull();
  });

  it("is importable without pulling in simple-git", async () => {
    // The import page renders this module in the browser bundle; a node-only
    // dependency here would break the build rather than a test. The module
    // also owns the remote-URL grammar (see remote.ts), which is what leaks
    // through these extra exports — all of them are pure.
    const source = await import("@/lib/git/github-url");
    expect(Object.keys(source).sort()).toEqual([
      "REMOTE_URL_PATTERNS",
      "isSafeRepoSegment",
      "matchGitHubRemoteUrl",
      "parseGitHubRepoInput",
    ].sort());
  });
});
