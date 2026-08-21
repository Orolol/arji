import { describe, it, expect } from "vitest";
import path from "node:path";
import { parseGitHubRepoInput } from "@/lib/git/remote";

const OWNER_REPO = { owner: "octocat", repo: "hello-world" };

describe("parseGitHubRepoInput — HTTPS/browser URL shapes", () => {
  it.each([
    "https://github.com/octocat/hello-world",
    "https://github.com/octocat/hello-world.git",
    "https://github.com/octocat/hello-world/",
    "http://github.com/octocat/hello-world",
    "http://github.com/octocat/hello-world.git",
    "https://www.github.com/octocat/hello-world",
    "https://www.github.com/octocat/hello-world.git",
    "github.com/octocat/hello-world",
    "www.github.com/octocat/hello-world",
  ])("parses %s", (input) => {
    expect(parseGitHubRepoInput(input)).toMatchObject(OWNER_REPO);
  });

  it("trims surrounding whitespace", () => {
    expect(
      parseGitHubRepoInput("  https://github.com/octocat/hello-world  ")
    ).toMatchObject(OWNER_REPO);
  });

  it("is case-insensitive on the host", () => {
    expect(
      parseGitHubRepoInput("https://GitHub.com/octocat/hello-world")
    ).toMatchObject(OWNER_REPO);
  });
});

describe("parseGitHubRepoInput — SSH and git protocol", () => {
  it.each([
    "git@github.com:octocat/hello-world.git",
    "git@github.com:octocat/hello-world",
    "ssh://git@github.com/octocat/hello-world",
    "ssh://git@github.com/octocat/hello-world.git",
    "git://github.com/octocat/hello-world",
    "git://github.com/octocat/hello-world.git",
  ])("parses %s", (input) => {
    expect(parseGitHubRepoInput(input)).toMatchObject(OWNER_REPO);
  });
});

describe("parseGitHubRepoInput — shorthand", () => {
  it("parses owner/repo", () => {
    expect(parseGitHubRepoInput("octocat/hello-world")).toMatchObject(
      OWNER_REPO
    );
  });

  it("parses owner/repo.git", () => {
    expect(parseGitHubRepoInput("octocat/hello-world.git")).toMatchObject(
      OWNER_REPO
    );
  });

  it("parses owner/repo with a trailing slash", () => {
    expect(parseGitHubRepoInput("octocat/hello-world/")).toMatchObject(
      OWNER_REPO
    );
  });

  it("rejects a bare owner with no repo", () => {
    expect(parseGitHubRepoInput("octocat")).toBeNull();
  });

  it("rejects three-segment shorthand", () => {
    expect(parseGitHubRepoInput("octocat/hello-world/extra")).toBeNull();
  });
});

describe("parseGitHubRepoInput — browser suffix stripping", () => {
  it.each([
    "https://github.com/octocat/hello-world/tree/main",
    "https://github.com/octocat/hello-world/tree/feat/some-branch",
    "https://github.com/octocat/hello-world/blob/main/README.md",
    "https://github.com/octocat/hello-world/pull/12",
    "https://github.com/octocat/hello-world/issues/3",
    "https://github.com/octocat/hello-world?tab=readme-ov-file",
    "https://github.com/octocat/hello-world#anchor",
    "https://github.com/octocat/hello-world.git#anchor",
    "https://github.com/octocat/hello-world/settings/actions",
    "github.com/octocat/hello-world/tree/main",
  ])("strips the suffix from %s", (input) => {
    expect(parseGitHubRepoInput(input)).toMatchObject(OWNER_REPO);
  });
});

describe("parseGitHubRepoInput — cloneUrl normalisation", () => {
  it.each([
    "https://github.com/octocat/hello-world",
    "https://www.github.com/octocat/hello-world.git",
    "http://github.com/octocat/hello-world/",
    "git@github.com:octocat/hello-world.git",
    "ssh://git@github.com/octocat/hello-world",
    "git://github.com/octocat/hello-world",
    "octocat/hello-world",
    "https://github.com/octocat/hello-world/pull/12",
  ])("normalises %s to the canonical HTTPS clone URL", (input) => {
    expect(parseGitHubRepoInput(input)?.cloneUrl).toBe(
      "https://github.com/octocat/hello-world.git"
    );
  });

  it("returns the full parsed shape", () => {
    expect(parseGitHubRepoInput("https://github.com/octocat/hello-world")).toEqual(
      {
        owner: "octocat",
        repo: "hello-world",
        ownerRepo: "octocat/hello-world",
        cloneUrl: "https://github.com/octocat/hello-world.git",
      }
    );
  });

  it("preserves owner/repo casing", () => {
    expect(parseGitHubRepoInput("https://github.com/OctoCat/Hello-World")).toEqual(
      {
        owner: "OctoCat",
        repo: "Hello-World",
        ownerRepo: "OctoCat/Hello-World",
        cloneUrl: "https://github.com/OctoCat/Hello-World.git",
      }
    );
  });

  it("accepts dots and underscores in names", () => {
    expect(parseGitHubRepoInput("my-org/my_cool.repo")).toMatchObject({
      owner: "my-org",
      repo: "my_cool.repo",
      cloneUrl: "https://github.com/my-org/my_cool.repo.git",
    });
  });
});

describe("parseGitHubRepoInput — non-GitHub hosts", () => {
  it.each([
    "https://gitlab.com/octocat/hello-world.git",
    "https://gitlab.com/octocat/hello-world",
    "git@gitlab.com:octocat/hello-world.git",
    "https://bitbucket.org/octocat/hello-world",
    "https://git.example.com/octocat/hello-world",
    "ssh://git@git.example.com/octocat/hello-world.git",
    "https://github.evil.com/octocat/hello-world",
    "https://notgithub.com/octocat/hello-world",
  ])("returns null for %s", (input) => {
    expect(parseGitHubRepoInput(input)).toBeNull();
  });

  it("returns null for a github.com URL with a single path segment", () => {
    expect(parseGitHubRepoInput("https://github.com/octocat")).toBeNull();
    expect(parseGitHubRepoInput("github.com/octocat")).toBeNull();
  });

  it("returns null for junk input", () => {
    expect(parseGitHubRepoInput("not-a-url")).toBeNull();
    expect(parseGitHubRepoInput("")).toBeNull();
    expect(parseGitHubRepoInput("   ")).toBeNull();
    expect(parseGitHubRepoInput("https://github.com/")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(
      parseGitHubRepoInput(undefined as unknown as string)
    ).toBeNull();
    expect(parseGitHubRepoInput(null as unknown as string)).toBeNull();
  });
});

describe("parseGitHubRepoInput — strict owner/repo validation", () => {
  it.each([
    ["parent traversal in repo", "octocat/.."],
    ["parent traversal in owner", "../hello-world"],
    ["dot repo", "octocat/."],
    ["dot owner", "./hello-world"],
    ["embedded traversal in repo", "octocat/he..llo"],
    ["embedded traversal in owner", "oct..ocat/hello-world"],
    ["encoded traversal", "https://github.com/octocat/%2e%2e"],
    ["backslash in repo", "octocat/hello\\world"],
    ["backslash traversal", "octocat/..\\..\\etc"],
    ["NUL byte in repo", "octocat/hello\0world"],
    ["NUL byte in URL", "https://github.com/octocat/hello\0world"],
    ["leading dash in repo", "octocat/-hello-world"],
    ["leading dash in owner", "-octocat/hello-world"],
    ["option injection", "--upload-pack=touch/pwned"],
    ["space in repo", "octocat/hello world"],
    ["tilde expansion", "octocat/~root"],
    ["at sign in owner", "octo@cat/hello-world"],
    ["colon in repo", "octocat/hello:world"],
  ])("rejects %s", (_label, input) => {
    expect(parseGitHubRepoInput(input)).toBeNull();
  });

  it("rejects traversal delivered through a full GitHub URL", () => {
    expect(parseGitHubRepoInput("https://github.com/octocat/..")).toBeNull();
    expect(
      parseGitHubRepoInput("git@github.com:../../../etc/passwd")
    ).toBeNull();
  });

  it("rejects before any path is computed", () => {
    // The parser is a pure function with no fs/network imports: a rejected
    // input never produces an owner/repo pair for cloneDestinationFor().
    expect(parseGitHubRepoInput("octocat/..")).toBeNull();
    expect(parseGitHubRepoInput("octocat/../../escape")).toBeNull();
  });

  it("still accepts legitimate names containing dots and dashes", () => {
    expect(parseGitHubRepoInput("some-org/repo.js")).toMatchObject({
      owner: "some-org",
      repo: "repo.js",
    });
    expect(parseGitHubRepoInput("dot.org/my.repo.name")).toMatchObject({
      owner: "dot.org",
      repo: "my.repo.name",
    });
  });
});

// Ported from the tests-and-docs epic (github-url-parse.test.ts): payload
// shapes and parser properties the suites above did not pin. All of them hold
// against the github-url.ts grammar — embedded `..` stays rejected here, per
// isSafeRepoSegment, unlike the narrower validatePath() posture.
describe("parseGitHubRepoInput — traversal payloads reach no filesystem path", () => {
  it.each([
    ["dot-dot in a git:// remote", "git://github.com/../etc/passwd"],
    ["absolute path as repo", "octocat//etc/passwd"],
    ["home-relative repo", "octocat/~/.ssh"],
    ["percent-encoded slash", "octocat/hello%2fworld"],
    ["double-encoded dot-dot", "octocat/%252e%252e"],
    ["windows drive letter", "C:/Windows/System32"],
    ["UNC path", "\\\\server\\share"],
    ["newline smuggling", "octocat/hello\nworld"],
    ["carriage return smuggling", "octocat/hello\rworld"],
    ["tab smuggling", "octocat/hello\tworld"],
    ["trailing dot-dot after a valid pair", "octocat/hello-world/.."],
    ["dot-dot dressed as a browser suffix", "github.com/octocat/../.."],
  ])("rejects %s", (_label, input) => {
    expect(parseGitHubRepoInput(input)).toBeNull();
  });

  it("never yields a segment that changes meaning when joined into a path", () => {
    // The contract resolveCloneDestination() depends on: whatever comes back,
    // the `<owner>-<repo>` directory name is a single, self-contained segment.
    const accepted = [
      "https://github.com/octocat/hello-world",
      "git@github.com:my-org/my_cool.repo.git",
      "dot.org/my.repo.name",
      "octocat/hello-world",
    ];

    for (const input of accepted) {
      const parsed = parseGitHubRepoInput(input);
      expect(parsed).not.toBeNull();

      const dirName = `${parsed!.owner}-${parsed!.repo}`;
      expect(path.basename(dirName)).toBe(dirName);
      expect(path.join("/srv/clones", dirName)).toBe(`/srv/clones/${dirName}`);
      expect(dirName).not.toMatch(/[/\\]/);
    }
  });
});

describe("parseGitHubRepoInput — properties", () => {
  it("is idempotent: re-parsing its own cloneUrl yields the same repo", () => {
    // Re-importing a project must resolve to the same destination, otherwise
    // the reuse branch of the clone service would never trigger.
    for (const input of [
      "https://github.com/octocat/hello-world/pull/12",
      "git@github.com:octocat/hello-world.git",
      "octocat/hello-world",
      "www.github.com/octocat/hello-world?tab=readme-ov-file",
    ]) {
      const first = parseGitHubRepoInput(input);
      expect(first).not.toBeNull();
      expect(parseGitHubRepoInput(first!.cloneUrl)).toEqual(first);
    }
  });

  it("refuses a URL carrying credentials rather than laundering them", () => {
    // `git_remote_url` is persisted on the project and shown in the UI, so a
    // tokenised remote must never become a parse result. Rejecting outright
    // (instead of stripping the userinfo) also keeps the user from believing
    // Arij stored the credentials they pasted.
    expect(
      parseGitHubRepoInput(
        "https://x-access-token:ghp_secret@github.com/octocat/hello-world.git"
      )
    ).toBeNull();
    expect(
      parseGitHubRepoInput("https://user@github.com/octocat/hello-world")
    ).toBeNull();
  });

  it("emits a clean https cloneUrl for every accepted shape", () => {
    for (const input of [
      "git@github.com:octocat/hello-world.git",
      "ssh://git@github.com/octocat/hello-world",
      "git://github.com/octocat/hello-world",
      "octocat/hello-world",
    ]) {
      const cloneUrl = parseGitHubRepoInput(input)?.cloneUrl;
      expect(cloneUrl).toBe("https://github.com/octocat/hello-world.git");
      expect(cloneUrl).not.toContain("@");
    }
  });
});
