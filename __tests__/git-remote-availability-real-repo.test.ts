import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GitRemoteNotConfiguredError,
  assertRemoteConfigured,
  getRemoteAvailability,
} from "@/lib/git/remote";

/**
 * Runs against real repositories rather than a mocked `simple-git`: the guard
 * exists to tell "this project has no origin" apart from a transport failure,
 * and only git itself can say what a remote-less repository actually reports.
 */
let tmpRoot: string;
let bareRemote: string;
let noRemote: string;
let withOrigin: string;
let withOtherRemote: string;
let pushOnlyOrigin: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/** A fresh repository at `<tmpRoot>/<name>`. */
function makeRepo(name: string): string {
  const repoPath = path.join(tmpRoot, name);
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, "init");
  return repoPath;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arij-remote-availability-"));

  bareRemote = path.join(tmpRoot, "origin.git");
  fs.mkdirSync(bareRemote, { recursive: true });
  git(bareRemote, "init", "--bare");

  noRemote = makeRepo("no-remote");

  withOrigin = makeRepo("with-origin");
  git(withOrigin, "remote", "add", "origin", bareRemote);

  withOtherRemote = makeRepo("other-remote");
  git(withOtherRemote, "remote", "add", "upstream", bareRemote);

  pushOnlyOrigin = makeRepo("push-only-origin");
  git(pushOnlyOrigin, "config", "remote.origin.pushurl", bareRemote);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("remote availability against real repositories", () => {
  it("reports a repository with no remotes as unconfigured", async () => {
    expect(await getRemoteAvailability(noRemote)).toEqual({
      remote: "origin",
      configured: false,
      configuredRemotes: [],
      fetchConfigured: false,
      pushConfigured: false,
      fetchRemotes: [],
      pushRemotes: [],
    });

    const error = await assertRemoteConfigured(
      noRemote,
      "origin",
      "fetch"
    ).catch((e) => e);
    expect(error).toBeInstanceOf(GitRemoteNotConfiguredError);
    expect(error.code).toBe("remote_not_configured");
  });

  it("reports a repository with a real origin as configured", async () => {
    expect(await getRemoteAvailability(withOrigin)).toEqual({
      remote: "origin",
      configured: true,
      configuredRemotes: ["origin"],
      fetchConfigured: true,
      pushConfigured: true,
      fetchRemotes: ["origin"],
      pushRemotes: ["origin"],
    });
    await expect(
      assertRemoteConfigured(withOrigin, "origin", "fetch")
    ).resolves.toBeUndefined();
  });

  it("offers the remote the repository does have when origin is missing", async () => {
    expect(await getRemoteAvailability(withOtherRemote)).toEqual({
      remote: "origin",
      configured: false,
      configuredRemotes: ["upstream"],
      fetchConfigured: false,
      pushConfigured: false,
      fetchRemotes: ["upstream"],
      pushRemotes: ["upstream"],
    });
    // ...and answers about that remote when it is the one asked for.
    expect(
      await getRemoteAvailability(withOtherRemote, "upstream")
    ).toMatchObject({ remote: "upstream", configured: true });
  });

  it("distinguishes a push-only origin from a remote that pull can fetch", async () => {
    expect(await getRemoteAvailability(pushOnlyOrigin)).toMatchObject({
      remote: "origin",
      fetchConfigured: false,
      pushConfigured: true,
      fetchRemotes: [],
      pushRemotes: ["origin"],
    });

    await expect(
      assertRemoteConfigured(pushOnlyOrigin, "origin", "fetch")
    ).rejects.toMatchObject({
      code: "remote_not_configured",
      operation: "fetch",
    });
    await expect(
      assertRemoteConfigured(pushOnlyOrigin, "origin", "push")
    ).resolves.toBeUndefined();
  });
});
