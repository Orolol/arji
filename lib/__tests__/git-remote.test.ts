import { describe, expect, it } from "vitest";
import { parseGitHubOwnerRepoFromRemoteUrl } from "@/lib/git/remote";

describe("parseGitHubOwnerRepoFromRemoteUrl", () => {
  it("parses SSH GitHub remotes", () => {
    const parsed = parseGitHubOwnerRepoFromRemoteUrl("git@github.com:octocat/hello-world.git");
    expect(parsed).toEqual({
      owner: "octocat",
      repo: "hello-world",
      ownerRepo: "octocat/hello-world",
    });
  });

  it("parses HTTPS GitHub remotes", () => {
    const parsed = parseGitHubOwnerRepoFromRemoteUrl("https://github.com/octocat/hello-world");
    expect(parsed).toEqual({
      owner: "octocat",
      repo: "hello-world",
      ownerRepo: "octocat/hello-world",
    });
  });

  it("returns null for non-GitHub remotes", () => {
    const parsed = parseGitHubOwnerRepoFromRemoteUrl("git@gitlab.com:octocat/hello-world.git");
    expect(parsed).toBeNull();
  });
});
