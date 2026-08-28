import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const gitMock = vi.hoisted(() => {
  const git: Record<string, Mock> = {};
  git.getRemotes = vi.fn();
  return git;
});

vi.mock("simple-git", () => ({
  default: vi.fn(() => gitMock),
  CheckRepoActions: { IS_REPO_ROOT: "root" },
}));

import {
  GitRemoteNotConfiguredError,
  assertRemoteConfigured,
  getRemoteAvailability,
} from "@/lib/git/remote";

/**
 * "This project has no origin" is a precondition, not a transport fault, so it
 * has to be decided from the repository's own remote list BEFORE git is asked
 * to talk to anything — reading it back out of a push/pull stderr string is
 * what produced the 500s in the first place.
 */
describe("getRemoteAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the remote as configured when it carries a fetch URL", async () => {
    gitMock.getRemotes.mockResolvedValue([
      { name: "origin", refs: { fetch: "https://github.com/owner/repo.git" } },
    ]);

    const availability = await getRemoteAvailability("/repo", "origin");

    expect(availability).toEqual({
      remote: "origin",
      configured: true,
      configuredRemotes: ["origin"],
    });
  });

  it("reports a repository with no remotes at all as unconfigured", async () => {
    gitMock.getRemotes.mockResolvedValue([]);

    const availability = await getRemoteAvailability("/repo");

    expect(availability.configured).toBe(false);
    expect(availability.configuredRemotes).toEqual([]);
  });

  it("lists the remotes the repository does have when the requested one is missing", async () => {
    gitMock.getRemotes.mockResolvedValue([
      { name: "upstream", refs: { fetch: "https://github.com/owner/repo.git" } },
      { name: "fork", refs: { push: "https://github.com/me/repo.git" } },
    ]);

    const availability = await getRemoteAvailability("/repo", "origin");

    expect(availability.configured).toBe(false);
    expect(availability.configuredRemotes).toEqual(["upstream", "fork"]);
  });

  it("treats a remote with no usable URL as not configured", async () => {
    gitMock.getRemotes.mockResolvedValue([
      { name: "origin", refs: { fetch: "   ", push: "" } },
    ]);

    const availability = await getRemoteAvailability("/repo", "origin");

    expect(availability.configured).toBe(false);
    expect(availability.configuredRemotes).toEqual([]);
  });

  it("rejects a flag-like remote name instead of probing git with it", async () => {
    await expect(
      getRemoteAvailability("/repo", "--upload-pack=evil")
    ).rejects.toThrow(/Invalid remote name/);
    expect(gitMock.getRemotes).not.toHaveBeenCalled();
  });
});

describe("assertRemoteConfigured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves silently when the remote exists", async () => {
    gitMock.getRemotes.mockResolvedValue([
      { name: "origin", refs: { fetch: "https://github.com/owner/repo.git" } },
    ]);

    await expect(assertRemoteConfigured("/repo", "origin")).resolves.toBeUndefined();
  });

  it("throws a machine-readable GitRemoteNotConfiguredError when it does not", async () => {
    gitMock.getRemotes.mockResolvedValue([
      { name: "upstream", refs: { fetch: "https://github.com/owner/repo.git" } },
    ]);

    const error = await assertRemoteConfigured("/repo", "origin").catch((e) => e);

    expect(error).toBeInstanceOf(GitRemoteNotConfiguredError);
    expect(error.code).toBe("remote_not_configured");
    expect(error.remote).toBe("origin");
    expect(error.configuredRemotes).toEqual(["upstream"]);
    expect(error.message).toContain("origin");
  });
});
