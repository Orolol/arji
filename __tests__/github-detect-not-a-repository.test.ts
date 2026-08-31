import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
 * Regression pin: a `gitRepoPath` that is not a usable git repository is a
 * configuration state the user can fix, not a server fault.
 *
 * `GitHubConnectBanner` fetches `GET /github/detect` on mount, so this fires
 * on every project page for such a project. The route used to hand git's own
 * `fatal: not a git repository` prose to `errorResponse(...)` — a 500 in the
 * browser console. The near miss is the point: a real repository with no
 * `origin` already answered `200 { detected: false }`, so only the
 * not-a-repository case degraded.
 *
 * Only `@/lib/db` is mocked. `lib/git/remote` runs for real against real
 * temporary directories, because the shape git produces for "this is not a
 * repository" is exactly what the route has to classify — a mocked rejection
 * would pin the handler, not the condition.
 */

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

const PROJECT_ID = "proj-detect";

let tmpRoot = "";
/** An ordinary directory that was never `git init`-ed. */
let notARepoPath = "";
/** A path that does not exist at all — a moved or deleted project directory. */
let missingPath = "";
/** A real repository with no remote: the near-miss control, must stay 200. */
let repoWithoutRemotePath = "";
/** A real repository whose origin is a GitHub URL: the success control. */
let repoWithGitHubRemotePath = "";
/**
 * A bare repository with a GitHub origin. Control, green on both sides of the
 * fix: `git remote -v` reads it fine but it is not "inside a work tree", so a
 * guard written on that question alone would newly refuse it.
 */
let bareRepoPath = "";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function seedProject(gitRepoPath: string): void {
  dbMockState.getQueue = [
    {
      id: PROJECT_ID,
      name: "Detect",
      gitRepoPath,
      githubOwnerRepo: null,
      defaultBranch: null,
    },
  ];
}

async function callDetect() {
  const { GET } = await import(
    "@/app/api/projects/[projectId]/github/detect/route"
  );
  return GET(mockNextRequest(), mockRouteContext({ projectId: PROJECT_ID }));
}

async function callDetectRemote() {
  const { POST } = await import(
    "@/app/api/projects/[projectId]/git/detect-remote/route"
  );
  return POST(
    mockNextRequest({ method: "POST" }),
    mockRouteContext({ projectId: PROJECT_ID })
  );
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arij-detect-not-a-repo-"));

  notARepoPath = path.join(tmpRoot, "plain-directory");
  fs.mkdirSync(notARepoPath, { recursive: true });

  missingPath = path.join(tmpRoot, "was-moved-away");

  repoWithoutRemotePath = path.join(tmpRoot, "repo-without-remote");
  fs.mkdirSync(repoWithoutRemotePath, { recursive: true });
  git(repoWithoutRemotePath, "init");

  repoWithGitHubRemotePath = path.join(tmpRoot, "repo-with-github-remote");
  fs.mkdirSync(repoWithGitHubRemotePath, { recursive: true });
  git(repoWithGitHubRemotePath, "init");
  git(
    repoWithGitHubRemotePath,
    "remote",
    "add",
    "origin",
    "https://github.com/octocat/hello-world.git"
  );

  bareRepoPath = path.join(tmpRoot, "bare-repo.git");
  fs.mkdirSync(bareRepoPath, { recursive: true });
  git(bareRepoPath, "init", "--bare");
  git(
    bareRepoPath,
    "remote",
    "add",
    "origin",
    "https://github.com/octocat/hello-world.git"
  );
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMockState();
});

describe("detectGitHubRemote against an unusable repository path", () => {
  it("rejects with a typed, machine-readable error when the path is not a repository", async () => {
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(notARepoPath)).rejects.toMatchObject({
      code: "GIT_REPO_NOT_A_REPOSITORY",
      repoPath: notARepoPath,
    });
  });

  it("rejects with a distinct code when the path does not exist", async () => {
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(missingPath)).rejects.toMatchObject({
      code: "GIT_REPO_PATH_MISSING",
      repoPath: missingPath,
    });
  });

  it("still resolves to null for a real repository with no remote", async () => {
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(repoWithoutRemotePath)).resolves.toBeNull();
  });

  it("still reads the remote of a bare repository", async () => {
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(bareRepoPath)).resolves.toMatchObject({
      ownerRepo: "octocat/hello-world",
    });
  });
});

describe("GET /api/projects/[projectId]/github/detect", () => {
  it("answers 400 with GIT_REPO_NOT_A_REPOSITORY instead of 500", async () => {
    seedProject(notARepoPath);

    const response = await callDetect();
    const body = await response.json();

    expect(response.status).not.toBe(500);
    expect(response.status).toBe(400);
    expect(body.code).toBe("GIT_REPO_NOT_A_REPOSITORY");
    expect(typeof body.error).toBe("string");
    expect(body.error.trim().length).toBeGreaterThan(0);
    // git's own prose is a transport-shaped message the UI cannot act on.
    expect(body.error).not.toMatch(/fatal:/i);
  });

  it("answers 400 with GIT_REPO_PATH_MISSING when the directory is gone", async () => {
    seedProject(missingPath);

    const response = await callDetect();
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe("GIT_REPO_PATH_MISSING");
  });

  it("audits the refusal in git_sync_log with its code", async () => {
    seedProject(notARepoPath);

    await callDetect();

    const logged = dbMockState.insertCalls as Array<{
      operation?: string;
      status?: string;
      detail?: string | null;
    }>;
    const detectRow = logged.find((row) => row.operation === "detect");

    expect(detectRow).toBeDefined();
    expect(detectRow?.status).toBe("failed");
    expect(detectRow?.detail).toContain("GIT_REPO_NOT_A_REPOSITORY");
  });

  it("still answers 200 { detected: false } for a repository with no remote", async () => {
    seedProject(repoWithoutRemotePath);

    const response = await callDetect();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ detected: false });
  });

  it("still answers 200 for a bare repository", async () => {
    seedProject(bareRepoPath);

    const response = await callDetect();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ detected: true, ownerRepo: "octocat/hello-world" });
  });

  it("still answers 200 with the owner/repo for a GitHub remote", async () => {
    seedProject(repoWithGitHubRemotePath);

    const response = await callDetect();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      detected: true,
      owner: "octocat",
      repo: "hello-world",
      ownerRepo: "octocat/hello-world",
      remoteName: "origin",
    });
  });
});

describe("POST /api/projects/[projectId]/git/detect-remote", () => {
  // Same shared helper, same condition: the sibling caller must not keep
  // answering 500 for the state its own no-origin branch already 400s on.
  it("answers 400 with GIT_REPO_NOT_A_REPOSITORY instead of 500", async () => {
    seedProject(notARepoPath);

    const response = await callDetectRemote();
    const body = await response.json();

    expect(response.status).not.toBe(500);
    expect(response.status).toBe(400);
    expect(body.code).toBe("GIT_REPO_NOT_A_REPOSITORY");
  });

  it("still answers 400 for a repository whose origin cannot be parsed", async () => {
    seedProject(repoWithoutRemotePath);

    const response = await callDetectRemote();
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBeUndefined();
  });

  it("still answers 200 for a parsable GitHub origin", async () => {
    seedProject(repoWithGitHubRemotePath);

    const response = await callDetectRemote();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ownerRepo).toBe("octocat/hello-world");
  });
});

/**
 * Locale independence.
 *
 * `simple-git` 3.36.0 turns git's exit 128 into "not a repository" only when
 * stderr matches `/Not a git repository|Kein Git-Repository/i` — English and
 * German. On a git built with any other translation the probe rejects with a
 * generic `GitError`, which escaped the guard and put both routes back on 500:
 * the exact defect this file pins, still reachable for a French or Spanish
 * user. The fix pins the probe's locale, so classification can no longer
 * depend on which language the machine's git speaks.
 *
 * No git translations are installed on CI or on this machine, so a French git
 * can only be exercised by controlling the executable. The shim below is
 * faithful rather than unconditional: it localizes exactly when the locale
 * asks it to, following the same gettext precedence real git does (LC_ALL over
 * LC_MESSAGES over LANG; LANGUAGE ignored under C/POSIX). That is what makes
 * the pinned-locale control meaningful — a shim that always spoke French would
 * pass a fix that merely swallowed every git error.
 */
describe("assertGitRepository against a localized git", () => {
  const LOCALE_KEYS = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] as const;

  let shimBinDir = "";
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    const realGit = execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();

    shimBinDir = path.join(tmpRoot, "localized-git-bin");
    fs.mkdirSync(shimBinDir, { recursive: true });
    fs.writeFileSync(
      path.join(shimBinDir, "git"),
      [
        "#!/bin/sh",
        'loc="$LC_ALL"',
        '[ -z "$loc" ] && loc="$LC_MESSAGES"',
        '[ -z "$loc" ] && loc="$LANG"',
        'case "$loc" in',
        '  C|POSIX|"") lang=en;;',
        '  *) if [ -n "$LANGUAGE" ]; then loc="$LANGUAGE"; fi',
        '     case "$loc" in fr*) lang=fr;; *) lang=en;; esac;;',
        "esac",
        'if [ "$lang" = fr ]; then',
        "  msg=\"fatal: ce n'est pas un depot git (ni aucun des repertoires parents) : .git\"",
        "else",
        '  msg="fatal: not a git repository (or any of the parent directories): .git"',
        "fi",
        // Lets a test stand in a *different* exit-128 fatal, to check the
        // classifier reads which failure it is rather than just the status.
        '[ -n "$SHIM_FATAL" ] && msg="$SHIM_FATAL"',
        // Real git decides; only its failure message is translated. A shim
        // that answered "not a repository" on its own would also "pass" a fix
        // that refused every repository.
        'if [ "$1" = "rev-parse" ]; then',
        `  out=$(${realGit} "$@" 2>/dev/null); rc=$?`,
        '  if [ $rc -eq 0 ]; then printf "%s\\n" "$out"; exit 0; fi',
        '  echo "$msg" >&2; exit $rc',
        "fi",
        `exec ${realGit} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      [...LOCALE_KEYS, "PATH", "SHIM_FATAL"].map((key) => [key, process.env[key]])
    );
    process.env.PATH = `${shimBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
    for (const key of LOCALE_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("classifies a plain directory when git speaks French", async () => {
    process.env.LANG = "fr_FR.UTF-8";
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(notARepoPath)).rejects.toMatchObject({
      code: "GIT_REPO_NOT_A_REPOSITORY",
      repoPath: notARepoPath,
    });
  });

  it("classifies a plain directory when LANGUAGE alone asks for French", async () => {
    // gettext consults LANGUAGE ahead of LANG, so a machine can speak French
    // through it while LANG still looks harmless.
    process.env.LANG = "en_US.UTF-8";
    process.env.LANGUAGE = "fr_FR";
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(notARepoPath)).rejects.toMatchObject({
      code: "GIT_REPO_NOT_A_REPOSITORY",
    });
  });

  it("answers 400, not 500, from the detect route when git speaks French", async () => {
    process.env.LANG = "fr_FR.UTF-8";
    seedProject(notARepoPath);

    const response = await callDetect();
    const body = await response.json();

    expect(response.status).not.toBe(500);
    expect(response.status).toBe(400);
    expect(body.code).toBe("GIT_REPO_NOT_A_REPOSITORY");
  });

  // Controls: green on both sides of the fix.

  it("still classifies a plain directory when git speaks English", async () => {
    process.env.LC_ALL = "C";
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(notARepoPath)).rejects.toMatchObject({
      code: "GIT_REPO_NOT_A_REPOSITORY",
    });
  });

  it("does not label an unrelated exit-128 fatal as a missing repository", async () => {
    // A dubious-ownership refusal is not "you never ran git init", and calling
    // it that would hand the user a wrong instruction. Exit 128 is git's
    // generic fatal, so the classifier has to read which failure it is; this
    // one stays an unexpected fault and keeps its 500.
    process.env.LC_ALL = "C";
    process.env.SHIM_FATAL =
      "fatal: detected dubious ownership in repository at '/repo'";
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    const failure = await detectGitHubRemote(notARepoPath).catch((e) => e);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({ code: "GIT_REPO_NOT_A_REPOSITORY" });
    expect(failure).not.toMatchObject({ code: "GIT_REPO_PATH_MISSING" });

    seedProject(notARepoPath);
    expect((await callDetect()).status).toBe(500);

    delete process.env.SHIM_FATAL;
  });

  it("does not refuse a real repository merely because the locale is French", async () => {
    process.env.LANG = "fr_FR.UTF-8";
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(
      detectGitHubRemote(repoWithGitHubRemotePath)
    ).resolves.toMatchObject({ ownerRepo: "octocat/hello-world" });
  });
});

/**
 * Shapes the guard must keep accepting.
 *
 * The membership test is `git rev-parse --is-inside-work-tree` exiting 0, which
 * is deliberately broader than "is a repository root": a `gitRepoPath` may
 * legitimately point at a subdirectory of a repository or at a linked worktree,
 * and Arij creates the latter itself under `.arij-worktrees`. A guard written
 * on `--is-repo-root` would newly refuse both, so they are pinned here rather
 * than probed by hand.
 */
describe("repository shapes the guard must not refuse", () => {
  let subdirPath = "";
  let linkedWorktreePath = "";
  let dotGitPath = "";

  beforeAll(() => {
    const host = path.join(tmpRoot, "host-repo");
    fs.mkdirSync(host, { recursive: true });
    git(host, "init");
    git(host, "remote", "add", "origin", "https://github.com/octocat/hello-world.git");
    git(host, "-c", "user.email=t@example.com", "-c", "user.name=T",
        "commit", "--allow-empty", "-m", "root");

    subdirPath = path.join(host, "nested", "deep");
    fs.mkdirSync(subdirPath, { recursive: true });

    dotGitPath = path.join(host, ".git");

    linkedWorktreePath = path.join(tmpRoot, "linked-worktree");
    git(host, "worktree", "add", "-b", "wt", linkedWorktreePath);
  });

  it("accepts a subdirectory of a repository", async () => {
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(subdirPath)).resolves.toMatchObject({
      ownerRepo: "octocat/hello-world",
    });
  });

  it("accepts a linked worktree, the shape Arij creates for every epic", async () => {
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(linkedWorktreePath)).resolves.toMatchObject({
      ownerRepo: "octocat/hello-world",
    });
  });

  it("accepts the .git directory itself", async () => {
    const { detectGitHubRemote } = await import("@/lib/git/remote");

    await expect(detectGitHubRemote(dotGitPath)).resolves.toMatchObject({
      ownerRepo: "octocat/hello-world",
    });
  });
});
