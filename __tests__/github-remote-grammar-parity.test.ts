import { describe, expect, it } from "vitest";
import { parseGitHubRepoInput } from "@/lib/git/github-url";
import { parseGitHubOwnerRepoFromRemoteUrl } from "@/lib/git/remote";

/**
 * `lib/git/github-url.ts` owns the GitHub remote-URL grammar; `remote.ts`
 * composes its server-side parser from it. This suite pins the two parsers
 * together so they can never drift apart: every remote-URL-shaped input they
 * accept must parse to the same owner/repo, and every unsafe or non-GitHub
 * input must be rejected by both.
 *
 * Only scheme-bearing inputs are compared: the client additionally accepts the
 * `owner/repo` shorthand and a scheme-less `github.com/owner/repo` paste,
 * which are not `git remote -v` output and are documented below.
 */
describe("client/server GitHub URL grammar parity", () => {
  it.each([
    "https://github.com/Orolol/arij",
    "https://github.com/Orolol/arij.git",
    "https://www.github.com/Orolol/arij",
    "http://github.com/Orolol/arij",
    "  https://github.com/Orolol/arij/  ",
    "git@github.com:Orolol/arij.git",
    "git@github.com:Orolol/arij",
    "ssh://git@github.com/Orolol/arij.git",
    "git://github.com/Orolol/arij.git",
  ])("accepts %s with the same owner/repo on both sides", (input) => {
    const server = parseGitHubOwnerRepoFromRemoteUrl(input);
    const client = parseGitHubRepoInput(input);

    expect(server, `server parser rejected: ${input}`).not.toBeNull();
    expect(client, `client parser rejected: ${input}`).not.toBeNull();
    expect(client?.ownerRepo).toBe(server?.ownerRepo);
  });

  it.each([
    ["", "empty"],
    ["https://gitlab.com/owner/repo", "another host"],
    ["git@gitlab.com:owner/repo", "another host over ssh"],
    ["https://github.com/onlyowner", "no repo segment"],
    ["https://github.com/../evil", "traversal in a url"],
    ["https://github.com/owner/..", "traversal as the repo"],
    ["https://github.com/./repo", "dot as the owner"],
    ["git@github.com:-owner/repo", "owner git would read as an option"],
    ["git@github.com:owner/-repo", "repo git would read as an option"],
    ["owner/re po", "whitespace"],
    ["owner/re\0po", "NUL byte"],
  ])("rejects %s (%s) on both sides", (input) => {
    expect(parseGitHubOwnerRepoFromRemoteUrl(input), "server").toBeNull();
    expect(parseGitHubRepoInput(input), "client").toBeNull();
  });

  it("documents the deliberate client-only conveniences", () => {
    // The client accepts the shorthand so users can paste `owner/repo`; the
    // server-side parser only ever sees `git remote -v` output, where a bare
    // shorthand is not a remote URL.
    expect(parseGitHubRepoInput("Orolol/arij")?.ownerRepo).toBe("Orolol/arij");
    expect(parseGitHubOwnerRepoFromRemoteUrl("Orolol/arij")).toBeNull();

    // A scheme-less github.com paste is a client convenience; the server
    // parser requires a scheme (or the git@/ssh://git:// forms).
    expect(parseGitHubRepoInput("github.com/Orolol/arij")?.ownerRepo).toBe(
      "Orolol/arij"
    );
    expect(parseGitHubOwnerRepoFromRemoteUrl("github.com/Orolol/arij")).toBeNull();
  });
});