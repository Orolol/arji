import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextResponse } from "next/server";

import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

/**
 * Convention pin: no git/* or github/* route may answer 500 for a
 * "not configured" / "no remote" precondition.
 *
 * Four routes used to (GET issues/triage, POST issues/sync, POST git/push,
 * POST git/pull) while `git/detect-remote` and `epics/:epicId/pr` already
 * answered 4xx for the very same class of condition. Fixing the four is not
 * enough: nothing stopped the next route from re-introducing the 500.
 *
 * So the route list here is DERIVED FROM THE ROUTE TREE, not hand-maintained:
 *
 *   1. Every `route.ts` under a `git` or `github` path segment must have an
 *      EXERCISED entry — it is really invoked against TWO fixtures, and for
 *      each one its status is asserted against a declared allow-list that
 *      never contains 500:
 *        a. a real repository with no remote and no GitHub configuration;
 *        b. a `gitRepoPath` that exists but was never `git init`-ed.
 *      Fixture (b) is the one this epic added. It catches a strictly larger
 *      defect: `git/status`, `git/push` and `git/pull` did not merely answer
 *      500 for it, they threw PAST their handler — Next's default error page,
 *      with no `{ error }` envelope for any client to read — while
 *      `github/detect` and `git/detect-remote` had already been fixed to
 *      answer 400 `GIT_REPO_NOT_A_REPOSITORY` for the very same path.
 *   2. Every route OUTSIDE that subtree whose source touches GitHub
 *      configuration (`githubOwnerRepo`, the stored PAT, the typed
 *      not-configured error) must be classified too — exercised, or EXCLUDED
 *      with a written reason.
 *
 * A newly added route in either set fails this test until it is classified,
 * rather than silently escaping the convention.
 *
 * Only `@/lib/db` is mocked. `lib/git/remote` runs for real against a real
 * temporary repository with no remote, because "no origin" is exactly the
 * state whose git-level shape the routes have to classify.
 */

/* ------------------------------------------------------------------ */
/* Table-addressed db mock                                             */
/* ------------------------------------------------------------------ */

/**
 * The shared queue mock in `helpers/db-mock` answers `.get()` in call order,
 * which cannot serve a dozen different routes issuing different reads from one
 * fixture. This one answers by TABLE, so seeding `projects` is enough and no
 * route's internal query order leaks into the test.
 */
const dbFixture = vi.hoisted(() => ({
  rows: new Map<string, unknown[]>(),
}));

interface MockQueryChain {
  where(...args: unknown[]): MockQueryChain;
  orderBy(...args: unknown[]): MockQueryChain;
  limit(...args: unknown[]): MockQueryChain;
  offset(...args: unknown[]): MockQueryChain;
  groupBy(...args: unknown[]): MockQueryChain;
  having(...args: unknown[]): MockQueryChain;
  leftJoin(...args: unknown[]): MockQueryChain;
  innerJoin(...args: unknown[]): MockQueryChain;
  rightJoin(...args: unknown[]): MockQueryChain;
  fullJoin(...args: unknown[]): MockQueryChain;
  as(...args: unknown[]): MockQueryChain;
  set(...args: unknown[]): MockQueryChain;
  values(...args: unknown[]): MockQueryChain;
  returning(...args: unknown[]): MockQueryChain;
  onConflictDoNothing(...args: unknown[]): MockQueryChain;
  onConflictDoUpdate(...args: unknown[]): MockQueryChain;
  from(table: unknown): MockQueryChain;
  get(): unknown;
  all(): unknown[];
  run(): { changes: number };
}

interface MockDb {
  select(...args: unknown[]): MockQueryChain;
  selectDistinct(...args: unknown[]): MockQueryChain;
  insert(table: unknown): MockQueryChain;
  update(table: unknown): MockQueryChain;
  delete(table: unknown): MockQueryChain;
  transaction<T>(fn: (tx: MockDb) => T): T;
}

vi.mock("@/lib/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const { rows } = dbFixture;

  const tableNameOf = (value: unknown): string | null => {
    try {
      return value ? getTableName(value as never) : null;
    } catch {
      return null;
    }
  };

  const makeChain = (initialTable: unknown): MockQueryChain => {
    let table = initialTable;
    const rowsForTable = (): unknown[] => rows.get(tableNameOf(table) ?? "") ?? [];
    const chain: MockQueryChain = {
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      offset: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      having: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      rightJoin: vi.fn(() => chain),
      fullJoin: vi.fn(() => chain),
      as: vi.fn(() => chain),
      set: vi.fn(() => chain),
      values: vi.fn(() => chain),
      returning: vi.fn(() => chain),
      onConflictDoNothing: vi.fn(() => chain),
      onConflictDoUpdate: vi.fn(() => chain),
      from: vi.fn((nextTable: unknown) => {
        table = nextTable;
        return chain;
      }),
      get: vi.fn(() => rowsForTable()[0] ?? null),
      all: vi.fn(() => rowsForTable()),
      run: vi.fn(() => ({ changes: 1 })),
    };
    return chain;
  };

  const db: MockDb = {
    select: vi.fn(() => makeChain(null)),
    selectDistinct: vi.fn(() => makeChain(null)),
    insert: vi.fn((t: unknown) => makeChain(t)),
    update: vi.fn((t: unknown) => makeChain(t)),
    delete: vi.fn((t: unknown) => makeChain(t)),
    transaction: <T>(fn: (tx: MockDb) => T) => fn(db),
  };

  return { db, sqlite: {}, ensureDbReady: vi.fn() };
});

/* ------------------------------------------------------------------ */
/* Route-tree derivation                                               */
/* ------------------------------------------------------------------ */

const REPO_ROOT = process.cwd();
const APP_DIR = path.join(REPO_ROOT, "app");
const API_DIR = path.join(APP_DIR, "api");

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** Route handlers are declared either as `export async function GET` or `export const GET =`. */
const HANDLER_EXPORT =
  /export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

/**
 * Source markers for "this route reasons about GitHub configuration". Kept as
 * identifiers rather than prose so a rename breaks the derivation loudly
 * instead of silently shrinking the audited set.
 */
const GITHUB_CONFIG_MARKERS =
  /githubOwnerRepo|getGitHubTokenFromSettings|GitHubNotConfiguredError|GITHUB_PAT_SETTING_KEY/;

interface DiscoveredRoute {
  /** URL path with Next's dynamic segments intact, e.g. `/api/projects/[projectId]/git/push`. */
  routePath: string;
  methods: HttpMethod[];
  /** True when a path segment is exactly `git` or `github`. */
  inGitTree: boolean;
  /** True when the handler source reasons about GitHub configuration. */
  touchesGitHubConfig: boolean;
}

function collectRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRouteFiles(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

function discoverRoutes(): DiscoveredRoute[] {
  return collectRouteFiles(API_DIR).map((file) => {
    const routePath =
      "/" + path.relative(APP_DIR, path.dirname(file)).split(path.sep).join("/");
    const source = fs.readFileSync(file, "utf-8");
    const segments = routePath.split("/");
    return {
      routePath,
      methods: [...source.matchAll(HANDLER_EXPORT)].map((m) => m[1] as HttpMethod),
      inGitTree: segments.includes("git") || segments.includes("github"),
      touchesGitHubConfig: GITHUB_CONFIG_MARKERS.test(source),
    };
  });
}

const discovered = discoverRoutes();
const key = (routePath: string, method: HttpMethod) => `${method} ${routePath}`;

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

/**
 * What a route may answer for ONE fixture. Both fixtures below are ordinary
 * recoverable states, so neither expectation may contain 500.
 */
interface FixtureExpectation {
  /** Statuses this route may answer for that fixture. Never 500. */
  allowed: number[];
  /** Why that is the right answer for this route. */
  note: string;
  /**
   * The machine-readable `code` the refusal payload must carry, when the route
   * declares one. Routes whose 4xx is plain input validation leave it unset.
   */
  code?: string;
}

interface ExercisedRoute extends FixtureExpectation {
  routePath: string;
  method: HttpMethod;
  /**
   * Expectations for the SECOND fixture: a `gitRepoPath` that exists but was
   * never `git init`-ed. The no-remote fixture cannot catch this class —
   * `git/status`, `git/push` and `git/pull` answered it with Next's default
   * 500 page (no `{ error }` envelope at all) long after `github/detect` and
   * `git/detect-remote` had been fixed to answer 400.
   */
  notARepository: FixtureExpectation;
  invoke: () => Promise<NextResponse | Response>;
}

/** The two fields every refusal payload is checked for. */
interface RefusalBody {
  error?: unknown;
  code?: unknown;
}

const PROJECT_ID = "proj-convention";
const EPIC_ID = "epic-convention";

/** A repository with no remote at all — created in `beforeAll`. */
let repoPath = "";
let pushOnlyRepoPath = "";
/** An existing directory that was never `git init`-ed — the second fixture. */
let notARepoPath = "";

const EXERCISED: ExercisedRoute[] = [
  {
    routePath: "/api/auth/github/device/start",
    method: "POST",
    allowed: [400],
    note:
      "Global and project-independent. With no OAuth App client ID it refuses as configuration, not as a fault — that refusal is exactly what tells Settings to fall back to a manual PAT.",
    code: "CLIENT_ID_NOT_CONFIGURED",
    notARepository: {
      allowed: [400],
      code: "CLIENT_ID_NOT_CONFIGURED",
      note:
        "Reads neither a project row nor a checkout, so an unusable repository path cannot change its answer.",
    },
    invoke: async () => {
      // The client ID is read from the environment at call time, so a value in
      // the developer's shell would send this pin over the network to
      // github.com. Cleared for the call, so the refusal asserted here is the
      // local, deterministic one the convention is about.
      const previous = process.env.ARIJ_GITHUB_OAUTH_CLIENT_ID;
      delete process.env.ARIJ_GITHUB_OAUTH_CLIENT_ID;
      try {
        const { POST } = await import("@/app/api/auth/github/device/start/route");
        return await POST(mockNextRequest({ method: "POST" }));
      } finally {
        if (previous !== undefined) {
          process.env.ARIJ_GITHUB_OAUTH_CLIENT_ID = previous;
        }
      }
    },
  },
  {
    routePath: "/api/auth/github/device/poll",
    method: "POST",
    allowed: [404],
    note:
      "Global and project-independent. A handle no sign-in was minted for is a missing resource, refused before any GitHub call — and it is what the client gets after a restart drops the in-memory flow.",
    code: "DEVICE_FLOW_NOT_FOUND",
    notARepository: {
      allowed: [404],
      code: "DEVICE_FLOW_NOT_FOUND",
      note:
        "Resolves an in-memory sign-in handle; it reads neither the project row nor the checkout.",
    },
    invoke: async () => {
      const { POST } = await import("@/app/api/auth/github/device/poll/route");
      return POST(mockNextRequest({ body: { handle: "gh-device-never-minted" } }));
    },
  },
  {
    routePath: "/api/projects/[projectId]/git/connect",
    method: "POST",
    allowed: [200],
    note:
      "Writes the owner/repo. It is the fix for the unconfigured state, so it must succeed while unconfigured.",
    notARepository: {
      allowed: [200],
      note:
        "Writes the owner/repo into the database and never touches git, so an unusable path is irrelevant to it.",
    },
    invoke: async () => {
      const { POST } = await import("@/app/api/projects/[projectId]/git/connect/route");
      return POST(
        mockNextRequest({ body: { ownerRepo: "orolol/arij" } }),
        mockRouteContext({ projectId: PROJECT_ID })
      );
    },
  },
  {
    routePath: "/api/projects/[projectId]/git/detect-remote",
    method: "POST",
    allowed: [400],
    note: "The convention's original reference: no parsable origin is a 400, never a fault.",
    notARepository: {
      allowed: [400],
      code: "GIT_REPO_NOT_A_REPOSITORY",
      note:
        "Already fixed by the adjacent epic: the shared assertGitRepository() guard refuses before reading remotes.",
    },
    invoke: async () => {
      const { POST } = await import(
        "@/app/api/projects/[projectId]/git/detect-remote/route"
      );
      return POST(mockNextRequest({ method: "POST" }), mockRouteContext({ projectId: PROJECT_ID }));
    },
  },
  {
    routePath: "/api/projects/[projectId]/git/pull",
    method: "POST",
    allowed: [409],
    note: "Regressed route: nothing to merge from a remote that does not exist — a conflict, not a fault.",
    code: "remote_not_configured",
    notARepository: {
      allowed: [400],
      code: "GIT_REPO_NOT_A_REPOSITORY",
      note:
        "Regressed route: its branch pre-read sat above the try, so git's fatal escaped the handler as a bare 500 page.",
    },
    invoke: async () => {
      const { POST } = await import("@/app/api/projects/[projectId]/git/pull/route");
      return POST(mockNextRequest({ body: {} }), mockRouteContext({ projectId: PROJECT_ID }));
    },
  },
  {
    routePath: "/api/projects/[projectId]/git/push",
    method: "POST",
    allowed: [409],
    note: "Regressed route: it used to surface git's raw transport prose as a 500.",
    code: "remote_not_configured",
    notARepository: {
      allowed: [400],
      code: "GIT_REPO_NOT_A_REPOSITORY",
      note:
        "Regressed route: same escaped branch pre-read, and the client got no `error` field at all to display.",
    },
    invoke: async () => {
      const { POST } = await import("@/app/api/projects/[projectId]/git/push/route");
      return POST(mockNextRequest({ body: {} }), mockRouteContext({ projectId: PROJECT_ID }));
    },
  },
  {
    routePath: "/api/projects/[projectId]/git/status",
    method: "GET",
    allowed: [200],
    note:
      "A read: the missing remote is reported inside the payload (`remoteConfigured: false`), not as a failure.",
    notARepository: {
      allowed: [400],
      code: "GIT_REPO_NOT_A_REPOSITORY",
      note:
        "Regressed route: unlike the missing remote, an unusable path has no in-payload representation — it is a refusal.",
    },
    invoke: async () => {
      const { GET } = await import("@/app/api/projects/[projectId]/git/status/route");
      return GET(
        mockNextRequest({ url: `http://localhost/api/projects/${PROJECT_ID}/git/status` }),
        mockRouteContext({ projectId: PROJECT_ID })
      );
    },
  },
  {
    routePath: "/api/projects/[projectId]/github/detect",
    method: "GET",
    allowed: [200],
    note: "Detection: `{ detected: false }` is the successful answer for a repository with no remote.",
    notARepository: {
      allowed: [400],
      code: "GIT_REPO_NOT_A_REPOSITORY",
      note:
        "Already fixed by the adjacent epic; pinned here so the whole subtree answers one way for one condition.",
    },
    invoke: async () => {
      const { GET } = await import("@/app/api/projects/[projectId]/github/detect/route");
      return GET(mockNextRequest(), mockRouteContext({ projectId: PROJECT_ID }));
    },
  },
  {
    routePath: "/api/projects/[projectId]/github/issues/import",
    method: "POST",
    allowed: [200, 201],
    note:
      "Imports from the local issue cache, so it needs no live GitHub configuration; an empty cache imports nothing.",
    notARepository: {
      allowed: [200, 201],
      note:
        "Imports from the local issue cache; it reads no git repository, so the path being unusable changes nothing.",
    },
    invoke: async () => {
      const { POST } = await import(
        "@/app/api/projects/[projectId]/github/issues/import/route"
      );
      return POST(
        mockNextRequest({ body: { issueNumbers: [1] } }),
        mockRouteContext({ projectId: PROJECT_ID })
      );
    },
  },
  {
    routePath: "/api/projects/[projectId]/github/issues/sync",
    method: "POST",
    allowed: [400],
    note: "Regressed route: an unlinked repository is a 400 carrying GITHUB_REPO_NOT_CONFIGURED.",
    code: "GITHUB_REPO_NOT_CONFIGURED",
    notARepository: {
      allowed: [400],
      code: "GITHUB_REPO_NOT_CONFIGURED",
      note:
        "Talks to the GitHub API, not the checkout: the unlinked repository is still the first precondition it hits.",
    },
    invoke: async () => {
      const { POST } = await import("@/app/api/projects/[projectId]/github/issues/sync/route");
      return POST(mockNextRequest({ method: "POST" }), mockRouteContext({ projectId: PROJECT_ID }));
    },
  },
  {
    routePath: "/api/projects/[projectId]/github/issues/triage",
    method: "GET",
    allowed: [400],
    note:
      "Regressed route: this is the one the /github-issues page logged a console 500 for on every load.",
    code: "GITHUB_REPO_NOT_CONFIGURED",
    notARepository: {
      allowed: [400],
      code: "GITHUB_REPO_NOT_CONFIGURED",
      note:
        "Same as issues/sync — it reads the GitHub link, never the working copy.",
    },
    invoke: async () => {
      const { GET } = await import("@/app/api/projects/[projectId]/github/issues/triage/route");
      return GET(
        mockNextRequest({
          url: `http://localhost/api/projects/${PROJECT_ID}/github/issues/triage`,
        }),
        mockRouteContext({ projectId: PROJECT_ID })
      );
    },
  },
  {
    routePath: "/api/projects/[projectId]/github/label-mapping",
    method: "GET",
    allowed: [200],
    note: "Reads local settings only; falls back to the built-in mapping when nothing is stored.",
    notARepository: {
      allowed: [200],
      note:
        "Reads local settings only; no git access on any path.",
    },
    invoke: async () => {
      const { GET } = await import("@/app/api/projects/[projectId]/github/label-mapping/route");
      return GET(mockNextRequest(), mockRouteContext({ projectId: PROJECT_ID }));
    },
  },
  {
    routePath: "/api/projects/[projectId]/github/label-mapping",
    method: "PUT",
    allowed: [200],
    note: "Writes local settings only; no GitHub precondition applies.",
    notARepository: {
      allowed: [200],
      note:
        "Writes local settings only; no git access on any path.",
    },
    invoke: async () => {
      const { PUT } = await import("@/app/api/projects/[projectId]/github/label-mapping/route");
      return PUT(
        mockNextRequest({ method: "PUT", body: { featureLabels: ["feature"] } }),
        mockRouteContext({ projectId: PROJECT_ID })
      );
    },
  },
  {
    routePath: "/api/settings/github/validate",
    method: "POST",
    allowed: [400],
    note: "Global, project-independent: a missing token is rejected as bad input before any GitHub call.",
    notARepository: {
      allowed: [400],
      note:
        "Global and project-independent, so it never sees this project's repository path.",
    },
    invoke: async () => {
      const { POST } = await import("@/app/api/settings/github/validate/route");
      return POST(mockNextRequest({ body: {} }));
    },
  },
  {
    // Outside the git/github subtree, but the epic cites it as the behaviour
    // the four regressed routes were supposed to match — so it is pinned here
    // rather than merely excluded.
    routePath: "/api/projects/[projectId]/epics/[epicId]/pr",
    method: "POST",
    allowed: [400],
    note: "Reference implementation of the convention: missing owner/repo is a 400.",
    notARepository: {
      allowed: [400],
      note:
        "Missing owner/repo is checked before any git work, so it refuses for the same reason on both fixtures.",
    },
    invoke: async () => {
      const { POST } = await import("@/app/api/projects/[projectId]/epics/[epicId]/pr/route");
      return POST(
        mockNextRequest({ body: {} }),
        mockRouteContext({ projectId: PROJECT_ID, epicId: EPIC_ID })
      );
    },
  },
];

/**
 * Routes outside the git/github subtree that reason about GitHub
 * configuration but are NOT driven here. Each needs a reason; a stale entry
 * (route moved or deleted) fails the derivation test below.
 */
const EXCLUDED: Array<{ routePath: string; reason: string }> = [
  {
    routePath: "/api/projects/[projectId]/epics/[epicId]/pr/sync",
    reason:
      "Reads back an already-created PR. It cannot be reached before /pr has succeeded, so the unconfigured state is unreachable through it.",
  },
  {
    routePath: "/api/projects/[projectId]/releases",
    reason:
      "Release creation is Git-local; the GitHub reference is an optional draft-release step guarded inside the release flow, covered by the release tests.",
  },
  {
    routePath: "/api/projects/[projectId]/releases/[releaseId]/publish",
    reason:
      "Publishing an existing release is a deliberate user action on a configured repo, not a page load; its unconfigured path is its own ticket.",
  },
  {
    routePath: "/api/projects/clone",
    reason:
      "Import-time route: it receives the repository URL in the request instead of reading stored project configuration, so it has no 'not configured' state.",
  },
  {
    routePath: "/api/projects",
    reason: "CRUD over the projects table; `githubOwnerRepo` is a stored column, not a precondition.",
  },
  {
    routePath: "/api/projects/[projectId]",
    reason: "CRUD over one project row; same as /api/projects.",
  },
  {
    routePath: "/api/settings",
    reason:
      "Stores the PAT. Its absence is the state being configured, so it can never be a precondition failure here.",
  },
];

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

let tmpRoot = "";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arij-route-status-"));
  repoPath = path.join(tmpRoot, "no-remote");
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, "init");
  // A commit so the current branch actually resolves: `git/status` reads
  // ahead/behind against it, and an unborn HEAD would fail for a reason that
  // has nothing to do with the missing remote.
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  git(repoPath, "add", "README.md");
  git(
    repoPath,
    "-c",
    "user.email=fixture@arij.local",
    "-c",
    "user.name=Arij Fixture",
    "commit",
    "-m",
    "initial"
  );

  notARepoPath = path.join(tmpRoot, "plain-directory");
  fs.mkdirSync(notARepoPath, { recursive: true });
  // Only meaningful while it really sits outside every repository: a temp dir
  // nested in one would make every not-a-repository assertion vacuously green.
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

  pushOnlyRepoPath = path.join(tmpRoot, "push-only-origin");
  fs.cpSync(repoPath, pushOnlyRepoPath, { recursive: true });
  const bareRemote = path.join(tmpRoot, "push-target.git");
  fs.mkdirSync(bareRemote, { recursive: true });
  git(bareRemote, "init", "--bare");
  git(pushOnlyRepoPath, "config", "remote.origin.pushurl", bareRemote);
});

afterAll(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Seeds the one project every route resolves. It always EXISTS and always has
 * a `gitRepoPath` — only what that path points at, and the missing GitHub
 * link, vary. Anything else would make the routes answer 404/400 for the
 * wrong reason. No `settings` rows are seeded either: no stored PAT.
 */
function seedProject(gitRepoPath: string): void {
  dbFixture.rows.clear();
  dbFixture.rows.set("projects", [
    {
      id: PROJECT_ID,
      name: "Convention",
      gitRepoPath,
      githubOwnerRepo: null,
      defaultBranch: null,
    },
  ]);
}

beforeEach(() => {
  seedProject(repoPath);
});

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("git/github route status-code convention", () => {
  it("classifies a real push-only origin as a pull precondition", async () => {
    seedProject(pushOnlyRepoPath);

    const { POST } = await import("@/app/api/projects/[projectId]/git/pull/route");
    const response = await POST(
      mockNextRequest({ body: {} }),
      mockRouteContext({ projectId: PROJECT_ID })
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: "remote_not_configured",
      remote: "origin",
      operation: "fetch",
    });
  });

  it("classifies every route the tree exposes under a git/ or github/ segment", () => {
    const classified = new Set(EXERCISED.map((r) => key(r.routePath, r.method)));

    const unclassified = discovered
      .filter((route) => route.inGitTree)
      .flatMap((route) =>
        route.methods
          .map((method) => key(route.routePath, method))
          .filter((k) => !classified.has(k))
      );

    expect(
      unclassified,
      "New git/github route handler(s) found. Add an EXERCISED entry driving each one " +
        "against BOTH fixtures (no remote, and a path that is not a repository) so it " +
        "cannot answer 500 for a precondition."
    ).toEqual([]);
  });

  it("classifies every route outside that subtree that reasons about GitHub configuration", () => {
    const classified = new Set([
      ...EXERCISED.map((r) => r.routePath),
      ...EXCLUDED.map((r) => r.routePath),
    ]);

    const unclassified = discovered
      .filter((route) => !route.inGitTree && route.touchesGitHubConfig)
      .map((route) => route.routePath)
      .filter((routePath) => !classified.has(routePath));

    expect(
      unclassified,
      "Route(s) touching GitHub configuration are neither exercised nor excluded. " +
        "Drive them here, or add an EXCLUDED entry saying why they cannot reach a precondition state."
    ).toEqual([]);
  });

  it("keeps the derivation honest: every declared route still exists in the tree", () => {
    const byPath = new Map(discovered.map((route) => [route.routePath, route]));

    for (const entry of EXERCISED) {
      const route = byPath.get(entry.routePath);
      expect(route, `EXERCISED entry points at a route that no longer exists: ${entry.routePath}`)
        .toBeDefined();
      expect(
        route?.methods,
        `${entry.routePath} no longer exports ${entry.method}`
      ).toContain(entry.method);
    }

    for (const entry of EXCLUDED) {
      expect(
        byPath.has(entry.routePath),
        `EXCLUDED entry points at a route that no longer exists: ${entry.routePath}`
      ).toBe(true);
      expect(entry.reason.trim().length, `EXCLUDED ${entry.routePath} has no reason`).
        toBeGreaterThan(20);
    }
  });

  it.each(EXERCISED.map((entry) => [key(entry.routePath, entry.method), entry] as const))(
    "%s does not answer 500 for a not-configured project",
    async (_label, entry) => {
      const response = await entry.invoke();
      const body = await response.json().catch(() => null);

      expect(
        response.status,
        `${entry.method} ${entry.routePath} answered 500 for an ordinary unconfigured state. ` +
          `Expected one of ${entry.allowed.join("/")} — ${entry.note}\n` +
          `Body: ${JSON.stringify(body)}`
      ).not.toBe(500);

      expect(
        entry.allowed,
        `${entry.method} ${entry.routePath} answered ${response.status}; ${entry.note}\n` +
          `Body: ${JSON.stringify(body)}`
      ).toContain(response.status);
    }
  );

  it.each(EXERCISED.map((entry) => [key(entry.routePath, entry.method), entry] as const))(
    "%s does not answer 500 for a path that is not a repository",
    async (_label, entry) => {
      seedProject(notARepoPath);

      // A handler that THROWS is the second half of the defect: Next turns the
      // rejection into its default error page, so the client sees a 500 with
      // no `{ error }` envelope at all. Caught here rather than left to bubble
      // so the failure names the contract instead of an anonymous rejection.
      let response: NextResponse | Response;
      try {
        response = await entry.invoke();
      } catch (error) {
        throw new Error(
          `${entry.method} ${entry.routePath} threw past its handler for a path that is not a ` +
            `repository, so Next answers its default 500 page with no { error } envelope. ` +
            `${entry.notARepository.note}\nThrown: ${
              error instanceof Error ? error.message : String(error)
            }`
        );
      }

      const body = await response.json().catch(() => null);
      const { allowed, note } = entry.notARepository;

      expect(
        response.status,
        `${entry.method} ${entry.routePath} answered 500 for a recoverable configuration state. ` +
          `Expected one of ${allowed.join("/")} — ${note}\nBody: ${JSON.stringify(body)}`
      ).not.toBe(500);

      expect(
        allowed,
        `${entry.method} ${entry.routePath} answered ${response.status}; ${note}\n` +
          `Body: ${JSON.stringify(body)}`
      ).toContain(response.status);
    }
  );

  it("answers every not-a-repository refusal with a payload the client can branch on", async () => {
    const refusals = EXERCISED.filter((entry) =>
      entry.notARepository.allowed.every((status) => status >= 400)
    );
    // The three regressed routes, the two the adjacent epic already fixed, and
    // the four that refuse for their own (GitHub-link) reason. A shrinking set
    // would mean a route quietly stopped refusing at all.
    expect(refusals.length).toBeGreaterThanOrEqual(9);
    expect(
      refusals.filter((entry) => entry.notARepository.code === "GIT_REPO_NOT_A_REPOSITORY")
        .length,
      "every route that actually reaches git must publish the shared code"
    ).toBeGreaterThanOrEqual(5);

    const defects: string[] = [];
    for (const entry of refusals) {
      seedProject(notARepoPath);
      const label = key(entry.routePath, entry.method);
      let body: RefusalBody | null = null;
      try {
        body = (await (await entry.invoke()).json()) as RefusalBody;
      } catch (error) {
        defects.push(
          `${label}: threw instead of returning a JSON envelope (${
            error instanceof Error ? error.message : String(error)
          })`
        );
        continue;
      }
      if (typeof body?.error !== "string" || body.error.trim().length === 0) {
        defects.push(`${label}: no human-readable error message`);
      }
      const expectedCode = entry.notARepository.code;
      if (expectedCode && body?.code !== expectedCode) {
        defects.push(
          `${label}: expected code ${expectedCode}, got ${JSON.stringify(body?.code)}`
        );
      }
    }

    expect(defects).toEqual([]);
  });

  it("answers every precondition refusal with a payload the client can branch on", async () => {
    // The status alone is not the contract: a 4xx carrying only prose leaves
    // the UI pattern-matching messages again, which is what this epic set out
    // to remove. Each refusal must carry a human-readable `error`, and the
    // routes that publish a machine code must keep publishing that exact code.
    const refusals = EXERCISED.filter((entry) =>
      entry.allowed.every((status) => status >= 400)
    );
    // The four regressed routes plus the two the epic cites as the reference.
    // A shrinking set would mean a route quietly stopped refusing at all.
    expect(refusals.length).toBeGreaterThanOrEqual(6);
    expect(refusals.filter((entry) => entry.code).length).toBeGreaterThanOrEqual(4);

    const defects: string[] = [];
    for (const entry of refusals) {
      const body = (await (await entry.invoke()).json()) as {
        error?: unknown;
        code?: unknown;
      };
      const label = key(entry.routePath, entry.method);
      if (typeof body.error !== "string" || body.error.trim().length === 0) {
        defects.push(`${label}: no human-readable error message`);
      }
      if (entry.code && body.code !== entry.code) {
        defects.push(`${label}: expected code ${entry.code}, got ${JSON.stringify(body.code)}`);
      }
    }

    expect(defects).toEqual([]);
  });

  it("runs under vitest's configured include/exclude globs", () => {
    // Acceptance criterion in its own right: this checkout also hosts foreign
    // trees (`.claude/`, `projects/`, `data/`) whose suites vitest
    // deliberately skips. A convention pin parked inside one of them would be
    // permanently green because it never ran.
    //
    // The config is read as SOURCE rather than imported: importing it pulls in
    // `vitest/config` -> esbuild, which throws under the jsdom environment
    // this suite runs in.
    const configSource = fs.readFileSync(path.join(REPO_ROOT, "vitest.config.ts"), "utf-8");
    const testBlock = configSource.slice(
      configSource.indexOf("test: {"),
      configSource.indexOf("coverage: {")
    );
    const globsOf = (field: "include" | "exclude"): string[] => {
      const match = new RegExp(`${field}:\\s*\\[([^\\]]*)\\]`).exec(testBlock);
      return [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };

    const include = globsOf("include");
    const exclude = globsOf("exclude");
    // A restructured config must fail here rather than silently reduce this
    // check to two assertions over empty lists.
    expect(include.length, "could not read test.include from vitest.config.ts").toBeGreaterThan(0);
    expect(exclude.length, "could not read test.exclude from vitest.config.ts").toBeGreaterThan(0);

    const selfPath = path
      .relative(REPO_ROOT, expect.getState().testPath ?? "")
      .split(path.sep);

    expect(selfPath[0], "test file must live inside the repo").not.toBe("..");
    expect(include.some((glob) => glob.endsWith(".test.{ts,tsx,mjs}"))).toBe(true);
    expect(selfPath.at(-1)).toMatch(/\.test\.ts$/);

    // Every exclude is a directory glob (`**/node_modules/**`, `data/**`, ...),
    // so a bare segment match is the exact condition that would skip us.
    const excludedSegments = exclude.map((glob) =>
      glob.replace(/\*\*\//g, "").replace(/\/\*\*$/, "")
    );
    const hit = excludedSegments.filter((segment) => selfPath.includes(segment));
    expect(hit, `this test file sits under an excluded directory: ${hit.join(", ")}`).toEqual([]);
  });
});
