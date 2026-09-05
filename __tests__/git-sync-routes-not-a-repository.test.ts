import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

/**
 * Regression pin: `git/status`, `git/push` and `git/pull` against a
 * `gitRepoPath` that is not a git repository.
 *
 * The adjacent epic fixed the two routes that reach git through
 * `detectGitHubRemote` (`GET github/detect`, `POST git/detect-remote`): both
 * answer `400 GIT_REPO_NOT_A_REPOSITORY`. The three routes that reach git
 * through `getRemoteAvailability` / `getCurrentGitBranch` were left behind and
 * degraded twice over:
 *
 *   1. the status was 500 for a recoverable configuration state, and
 *   2. the body was Next's default error page, not `{ error }` at all —
 *      `getCurrentGitBranch` sits ABOVE each handler's `try`, so git's
 *      `fatal: not a git repository` escaped the handler entirely and every
 *      client reading `payload.error` got `undefined`.
 *
 * Only `@/lib/db`, the sync-log writer and agent resolution are mocked.
 * `lib/git/remote` runs for real against real temporary directories: the shape
 * git produces for "this is not a repository" is precisely what the routes
 * have to classify, and a mocked rejection would pin the handler rather than
 * the condition.
 */

const mockWriteGitSyncLog = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/github/sync-log", () => ({
  writeGitSyncLog: mockWriteGitSyncLog,
}));

vi.mock("@/lib/agent-config/agent-resolution", () => ({
  resolveAgentByNamedId: vi.fn(() => ({
    provider: "claude-code",
    model: "claude-opus-4-6",
    namedAgentId: null,
    name: null,
  })),
}));

const PROJECT_ID = "proj-not-a-repo";

let tmpRoot = "";
/** An existing directory that was never `git init`-ed — the reported state. */
let notARepoPath = "";
/** A project directory that was moved or deleted out from under the project. */
let missingPath = "";
/**
 * A real repository with no remote. The near-miss control: it must keep its
 * existing answers on BOTH sides of the fix, or the guard is over-refusing.
 */
let repoWithoutRemotePath = "";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function seedProject(gitRepoPath: string): void {
  dbMockState.getQueue = [
    {
      id: PROJECT_ID,
      name: "Not a repo",
      gitRepoPath,
      githubOwnerRepo: null,
      defaultBranch: null,
    },
  ];
}

/**
 * Invokes a handler and normalises BOTH failure modes into one value.
 *
 * A handler that throws is the defect this file exists for: Next turns the
 * rejection into its default 500 page, so `thrown` being set means there was
 * no `{ error }` envelope for any client to read.
 */
async function call(
  invoke: () => Promise<Response>
): Promise<{ status: number | null; body: unknown; thrown: unknown }> {
  try {
    const response = await invoke();
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      thrown: null,
    };
  } catch (error) {
    return { status: null, body: null, thrown: error };
  }
}

function callStatus(search = "") {
  return call(async () => {
    const { GET } = await import("@/app/api/projects/[projectId]/git/status/route");
    return GET(
      mockNextRequest({
        url: `http://localhost/api/projects/${PROJECT_ID}/git/status${search}`,
      }),
      mockRouteContext({ projectId: PROJECT_ID })
    );
  });
}

function callPush(body: Record<string, unknown> = {}) {
  return call(async () => {
    const { POST } = await import("@/app/api/projects/[projectId]/git/push/route");
    return POST(
      mockNextRequest({ body }),
      mockRouteContext({ projectId: PROJECT_ID })
    );
  });
}

function callPull(body: Record<string, unknown> = {}) {
  return call(async () => {
    const { POST } = await import("@/app/api/projects/[projectId]/git/pull/route");
    return POST(
      mockNextRequest({ body }),
      mockRouteContext({ projectId: PROJECT_ID })
    );
  });
}

const ROUTES = [
  { label: "GET git/status", invoke: () => callStatus() },
  { label: "POST git/push", invoke: () => callPush() },
  { label: "POST git/pull", invoke: () => callPull() },
] as const;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arij-git-sync-not-a-repo-"));

  notARepoPath = path.join(tmpRoot, "plain-directory");
  fs.mkdirSync(notARepoPath, { recursive: true });

  missingPath = path.join(tmpRoot, "was-moved-away");

  repoWithoutRemotePath = path.join(tmpRoot, "repo-without-remote");
  fs.mkdirSync(repoWithoutRemotePath, { recursive: true });
  git(repoWithoutRemotePath, "init");
  // A commit so the current branch resolves: the status read compares against
  // it, and an unborn HEAD would fail for a reason unrelated to this epic.
  fs.writeFileSync(path.join(repoWithoutRemotePath, "README.md"), "# fixture\n");
  git(repoWithoutRemotePath, "add", "README.md");
  git(
    repoWithoutRemotePath,
    "-c",
    "user.email=fixture@arij.local",
    "-c",
    "user.name=Arij Fixture",
    "commit",
    "-m",
    "initial"
  );

  // The fixture is only meaningful while it really is outside any repository.
  // A temp dir nested in one (or a stray `git init` above it) would make every
  // assertion below vacuous, so fail loudly instead.
  let insideRepo = true;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: notARepoPath,
      stdio: "pipe",
    });
  } catch {
    insideRepo = false;
  }
  if (insideRepo) {
    throw new Error(
      `Fixture invalid: ${notARepoPath} is inside a git repository, so "not a repository" is untestable here.`
    );
  }
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMockState();
  mockWriteGitSyncLog.mockReset();
});

describe("git sync routes against a path that is not a repository", () => {
  it.each(ROUTES.map((route) => [route.label, route] as const))(
    "%s returns a response instead of throwing past the handler",
    async (_label, route) => {
      seedProject(notARepoPath);
      const { thrown, status, body } = await route.invoke();

      expect(
        thrown,
        "the handler threw, so Next answers its default 500 page and the " +
          "`{ error }` envelope every client reads is absent"
      ).toBeNull();
      expect(status).not.toBe(500);
      expect(
        (body as { error?: unknown } | null)?.error,
        "a refusal must carry a human-readable message"
      ).toEqual(expect.any(String));
    }
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    "%s answers 400 GIT_REPO_NOT_A_REPOSITORY",
    async (_label, route) => {
      seedProject(notARepoPath);
      const { status, body } = await route.invoke();

      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
      expect(String((body as { error: string }).error)).toContain(notARepoPath);
    }
  );

  it.each(ROUTES.map((route) => [route.label, route] as const))(
    "%s answers 400 GIT_REPO_PATH_MISSING when the directory is gone",
    async (_label, route) => {
      seedProject(missingPath);
      const { status, body } = await route.invoke();

      expect(status).toBe(400);
      expect(body).toMatchObject({ code: "GIT_REPO_PATH_MISSING" });
    }
  );

  it("refuses a push even when the caller supplies the branch itself", async () => {
    // Guards the fix against being a side effect of the branch read: with
    // `branch` in the body `getCurrentGitBranch` is never called, and the
    // route still must not treat an unusable path as a transport fault.
    seedProject(notARepoPath);
    const { status, body } = await callPush({ branch: "main" });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
  });

  it("refuses a pull even when the caller supplies the branch itself", async () => {
    seedProject(notARepoPath);
    const { status, body } = await callPull({ branch: "main" });

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
  });

  it("refuses a status read even when the caller supplies the branch itself", async () => {
    seedProject(notARepoPath);
    const { status, body } = await callStatus("?branch=main");

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
  });

  it("audits the push refusal in git_sync_log with its code", async () => {
    seedProject(notARepoPath);
    await callPush();

    const audited = mockWriteGitSyncLog.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.operation === "push" && entry.status === "failed");
    expect(audited).toHaveLength(1);
    expect(audited[0].detail).toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
  });

  it("audits the pull refusal in git_sync_log with its code", async () => {
    seedProject(notARepoPath);
    await callPull();

    const audited = mockWriteGitSyncLog.mock.calls
      .map(([entry]) => entry)
      .filter((entry) => entry.operation === "pull" && entry.status === "failed");
    expect(audited).toHaveLength(1);
    expect(audited[0].detail).toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
  });
});

describe("controls: a real repository with no remote keeps its answers", () => {
  it("GET git/status still answers 200 and reports the missing remote", async () => {
    seedProject(repoWithoutRemotePath);
    const { status, body } = await callStatus();

    expect(status).toBe(200);
    expect((body as { data: { remoteConfigured: boolean } }).data.remoteConfigured).toBe(
      false
    );
  });

  it("POST git/push still answers 409 remote_not_configured", async () => {
    seedProject(repoWithoutRemotePath);
    const { status, body } = await callPush();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "remote_not_configured", operation: "push" });
  });

  it("POST git/pull still answers 409 remote_not_configured", async () => {
    seedProject(repoWithoutRemotePath);
    const { status, body } = await callPull();

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "remote_not_configured", operation: "fetch" });
  });
});
