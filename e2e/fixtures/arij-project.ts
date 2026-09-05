import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DATA_ROOT, DATABASE_FILE, withDatabase } from "./data-root";

/**
 * A throwaway Arij project, board URL included.
 *
 * The board is only reachable for a project row that already exists, and every
 * spec here creates tickets on it — so each test gets its own project pointing
 * at its own scratch git repo under the OS temp directory. Nothing a test
 * creates can then reach another test's board, and the `arji.json` the sync
 * export writes lands in the scratch repo rather than in this one.
 */
export interface ArijProject {
  id: string;
  name: string;
  /** Absolute path of the scratch repo the project is attached to. */
  repoPath: string;
  /**
   * The temp directory holding the repo — and everything Arij creates BESIDE
   * it, which is why the fixture tracks it separately: `createWorktree` puts
   * an epic's worktree in `<repoPath>/../.arij-worktrees` (lib/git/manager.ts),
   * so the repository has to sit one level down or a build would leave
   * worktrees in the OS temp root that nothing owns.
   */
  rootPath: string;
  /** Path to navigate to for the kanban board. */
  boardUrl: string;
}

/**
 * `validatePath` (which `POST /api/projects` runs on `gitRepoPath`) requires an
 * existing directory, and the board's git surfaces expect a real repository
 * with a branch — hence the empty initial commit rather than a bare `mkdir`.
 */
function createScratchRepo(): { rootPath: string; repoPath: string } {
  const rootPath = mkdtempSync(path.join(tmpdir(), "arij-e2e-"));
  const dir = path.join(rootPath, "repo");
  mkdirSync(dir);

  git(dir, "init", "-b", "main");
  // Written into the repository's own config rather than passed per command:
  // the merge route commits through simple-git, which knows nothing about
  // this fixture. Without a local identity that merge fails on a machine
  // whose global git config has none, and gpg signing would prompt.
  git(dir, "config", "user.email", "e2e@arij.local");
  git(dir, "config", "user.name", "Arij E2E");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "commit", "--allow-empty", "-m", "initial");

  return { rootPath, repoPath: dir };
}

/** Runs one git command in `repoPath`, throwing on a non-zero exit. */
function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Every local branch of `repoPath`, so a test can assert one is gone. */
export function localBranches(repoPath: string): string[] {
  return git(repoPath, "branch", "--format=%(refname:short)")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The subject lines of `branch`, newest first. */
export function commitSubjects(repoPath: string, branch = "main"): string[] {
  return git(repoPath, "log", "--format=%s", branch)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Every path the upload route stores for a project, whatever the data root:
 * `data/uploads/<projectId>/<file>` is built as a literal string in the route,
 * not from `process.cwd()`.
 *
 * GLOB rather than LIKE: nanoid ids routinely contain `_`, which LIKE reads as
 * a single-character wildcard, while none of GLOB's metacharacters (`*`, `?`,
 * `[`) occur in the nanoid alphabet.
 */
function uploadPathPattern(projectId: string): string {
  return `data/uploads/${projectId}/*`;
}

/**
 * Fail before the test body if the runner and the server disagree on which
 * database is live.
 *
 * Teardown keys off `projectId` alone, so a wrong data root would delete
 * nothing and still assert clean — a silent no-op is the exact failure this
 * fixture exists to prevent.
 */
function assertSharedDatabase(projectId: string): void {
  expect(
    existsSync(DATABASE_FILE),
    `no Arij database at ${DATABASE_FILE}; point E2E_DATA_ROOT (or ARIJ_DB_PATH) at the database of the server under test`
  ).toBe(true);

  const row = withDatabase((db) =>
    db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId)
  );
  expect(
    row,
    `the project this fixture just created is absent from ${DATABASE_FILE}, so the server writes elsewhere; point E2E_DATA_ROOT (or ARIJ_DB_PATH) at the database it opens`
  ).toBeTruthy();
}

/** What `DELETE /api/projects/:id` should have removed and didn't. */
interface UploadResidue {
  /** `chat_attachments` rows still naming this project's upload directory. */
  rows: number;
  /** Whether `data/uploads/<projectId>/` was still on disk. */
  directory: boolean;
}

/**
 * Reports what the project delete left behind — and removes it.
 *
 * This used to be a workaround: before migration `0030` a `chat_attachments`
 * row carried no project column, so nothing cascaded it and the fixture had to
 * delete the rows itself. `0030` gave every upload a cascading `project_id`,
 * and `DELETE /api/projects/:id` now unlinks the bytes through
 * `deleteProjectUploads()`. So the cleanup is the *app's* job, and what is
 * useful here is checking that it did it — on real rows and real files, which
 * no unit test reaches.
 *
 * Residue is still removed, not just counted: a regression should fail the run
 * that caused it rather than leak into the developer's instance and every run
 * afterwards. Measuring before removing is what keeps the assertion honest —
 * cleaning first would make it pass by construction, which is exactly the
 * vacuity this function used to have.
 *
 * Matched on `file_path` rather than on `project_id`: the column whose cascade
 * is under test cannot also be the probe that decides whether it worked. GLOB
 * rather than LIKE — nanoid ids routinely contain `_`, which LIKE reads as a
 * single-character wildcard, while none of GLOB's metacharacters (`*`, `?`,
 * `[`) occur in the nanoid alphabet.
 */
function takeUploadResidue(projectId: string): UploadResidue {
  const uploadsDir = path.join(DATA_ROOT, "uploads", projectId);
  const directory = existsSync(uploadsDir);
  rmSync(uploadsDir, { recursive: true, force: true });

  // A wrong data root is `assertSharedDatabase`'s to report; opening a database
  // that isn't there would only replace its message with a driver error.
  if (!existsSync(DATABASE_FILE)) return { rows: 0, directory };

  const pattern = uploadPathPattern(projectId);
  return withDatabase((db) => {
    const rows = (
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_attachments WHERE file_path GLOB ?")
        .get(pattern) as { count: number }
    ).count;

    if (rows > 0) {
      db.prepare("DELETE FROM chat_attachments WHERE file_path GLOB ?").run(pattern);
    }

    return { rows, directory };
  });
}

/** Whether the project row survived its own delete. */
function projectRowExists(projectId: string): boolean {
  if (!existsSync(DATABASE_FILE)) return false;

  return withDatabase(
    (db) => db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId) !== undefined
  );
}

/**
 * Deletes the project, reporting failure instead of throwing it.
 *
 * The teardown has disk cleanup left to do after this call, and a request that
 * threw here would skip it — leaving behind the scratch repo and uploads of the
 * very run that already went wrong. The verdict is asserted once everything
 * else has been cleaned.
 */
async function deleteProject(
  request: APIRequestContext,
  projectId: string
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await withTransportRetry(() =>
      request.delete(`/api/projects/${projectId}`)
    );
    if (response.ok()) return { ok: true, detail: String(response.status()) };

    return { ok: false, detail: `${response.status()} ${await response.text()}` };
  } catch (error) {
    return { ok: false, detail: `request failed: ${String(error)}` };
  }
}

/**
 * Runs an API call, retrying once when the CONNECTION failed rather than the
 * request.
 *
 * `read ECONNRESET` is the dev server dropping a socket, not an answer about
 * the product: it shows up on the fixture's own reads when the machine is
 * oversubscribed (several agent sessions share this one, and four workers
 * already share a single `next dev`). Retrying it keeps a transport hiccup
 * from being reported as a board that failed to move.
 *
 * Deliberately narrow. Only a thrown transport error is retried — any response
 * the server actually produced, success or 500, is returned untouched, so no
 * assertion is softened. One retry, because a second reset in a row is a
 * server that is genuinely gone and should be reported as such.
 */
async function withTransportRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!/ECONNRESET|ECONNREFUSED|socket hang up/i.test(String(error))) throw error;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await call();
  }
}

/** An epic as the board fixtures hand it back: enough to address it later. */
export interface SeededEpic {
  id: string;
  title: string;
  readableId: string | null;
}

/**
 * Creates an epic through the real route.
 *
 * Board tests need a card to act on, not a creation flow — that one is
 * covered by `epic-manual-creation.spec.ts`. Going through the API keeps the
 * arrange step out of the assertions and out of the drag timing.
 */
export async function createEpic(
  request: APIRequestContext,
  projectId: string,
  title: string,
  description = "Created by the e2e suite."
): Promise<SeededEpic> {
  const created = await withTransportRetry(() =>
    request.post(`/api/projects/${projectId}/epics`, {
      data: { title, description },
    })
  );
  expect(
    created.ok(),
    `epic creation failed: ${created.status()} ${await created.text()}`
  ).toBeTruthy();

  const { data } = (await created.json()) as {
    data: { id: string; readableId?: string | null };
  };
  return { id: data.id, title, readableId: data.readableId ?? null };
}

/**
 * The status the server has stored for an epic right now.
 *
 * The board moves a card optimistically and only rolls back once the reorder
 * route answers, so the rendered column is never on its own evidence that a
 * transition was accepted. This is.
 */
export async function storedEpicStatus(
  request: APIRequestContext,
  projectId: string,
  epicId: string
): Promise<string> {
  const response = await withTransportRetry(() =>
    request.get(`/api/projects/${projectId}/epics`)
  );
  expect(response.ok(), `epics read failed: ${response.status()}`).toBeTruthy();
  const { data } = (await response.json()) as {
    data: { id: string; status: string }[];
  };
  return data.find((epic) => epic.id === epicId)?.status ?? "<absent>";
}

/**
 * The titles of one column's epics, in the order the server ranks them.
 *
 * `epics.position` is the board's execution order, so this — not the rendered
 * column — is what a reorder has to have changed.
 */
export async function storedColumnOrder(
  request: APIRequestContext,
  projectId: string,
  status: string
): Promise<string[]> {
  const response = await withTransportRetry(() =>
    request.get(`/api/projects/${projectId}/epics`)
  );
  expect(response.ok(), `epics read failed: ${response.status()}`).toBeTruthy();
  const { data } = (await response.json()) as {
    data: { title: string; status: string; position: number }[];
  };
  return data
    .filter((epic) => epic.status === status)
    .sort((a, b) => a.position - b.position)
    .map((epic) => epic.title);
}

/** The branch the epic row still points at, if any. */
export async function storedEpicBranch(
  request: APIRequestContext,
  projectId: string,
  epicId: string
): Promise<string | null> {
  const response = await withTransportRetry(() =>
    request.get(`/api/projects/${projectId}/epics`)
  );
  expect(response.ok(), `epics read failed: ${response.status()}`).toBeTruthy();
  const { data } = (await response.json()) as {
    data: { id: string; branchName: string | null }[];
  };
  return data.find((epic) => epic.id === epicId)?.branchName ?? null;
}

/** One agent session, as the sessions route reports it. */
export interface StoredSession {
  id: string;
  agentType: string | null;
  status: string;
  provider: string | null;
  outcome: string | null;
  reviewVerdict: string | null;
  error: string | null;
  branchName: string | null;
}

/**
 * The agent sessions a ticket accumulated, oldest first.
 *
 * A journey that dispatches real builds and reviews is judged on these rows:
 * they are what the routes create, what the scheduler runs, and what the
 * workflow transitions read. `kind` separates them from the chat
 * conversations the same endpoint returns.
 */
export async function epicSessions(
  request: APIRequestContext,
  projectId: string,
  epicId: string
): Promise<StoredSession[]> {
  const response = await withTransportRetry(() =>
    request.get(`/api/projects/${projectId}/sessions`)
  );
  expect(response.ok(), `sessions read failed: ${response.status()}`).toBeTruthy();
  const { data } = (await response.json()) as {
    data: ({ kind: string; epicId: string | null; createdAt: string } & StoredSession)[];
  };
  return data
    .filter((row) => row.kind === "agent_session" && row.epicId === epicId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(row => ({
      ...row,
      // The deliberately compact session list omits the structured verdict.
      // Read the persisted verdict, without inflating the production endpoint.
      reviewVerdict: withDatabase(db => (db.prepare(
        "SELECT review_verdict FROM agent_sessions WHERE id = ? AND project_id = ?"
      ).get(row.id, projectId) as { review_verdict: string | null }).review_verdict),
    }));
}

/** The review findings filed against a ticket, oldest first. */
export async function epicFindings(
  request: APIRequestContext,
  projectId: string,
  epicId: string
): Promise<{ body: string; status: string; filePath: string; agentSessionId: string | null }[]> {
  const response = await withTransportRetry(() =>
    request.get(`/api/projects/${projectId}/epics/${epicId}/review-comments`)
  );
  expect(response.ok(), `findings read failed: ${response.status()}`).toBeTruthy();
  const { data } = (await response.json()) as {
    data: { body: string; status: string; filePath: string; agentSessionId: string | null }[];
  };
  return data;
}

/**
 * Agent types a dispatch journey pins to a known provider.
 *
 * `build` is the epic build route's, `review_feature` the one
 * `REVIEW_TYPE_TO_AGENT_TYPE` maps the dialog's default review type to.
 */
export const PINNED_AGENT_TYPES = [
  "build",
  "review_feature",
  "refinement",
] as const;

/**
 * Pins this project's dispatches to claude-code.
 *
 * Agent resolution is a precedence chain (explicit choice, project role,
 * global role, built-in claude-code fallback), and the suite runs against the
 * developer's real database — where a global role assignment pointing `build`
 * at another CLI is perfectly ordinary. Without a project-scoped pin, whose
 * provider a journey lands on would depend on the machine it runs on.
 *
 * The other providers' stubs refuse to run agents, so a pin that stopped
 * working fails the journey with a readable error instead of reaching a real
 * CLI — but it should not come to that, which is what this is for.
 */
export async function pinProjectAgents(
  request: APIRequestContext,
  projectId: string
): Promise<void> {
  for (const agentType of PINNED_AGENT_TYPES) {
    const response = await request.put(
      `/api/projects/${projectId}/agent-config/providers/${agentType}`,
      { data: { provider: "claude-code" } }
    );
    expect(
      response.ok(),
      `pinning ${agentType} failed: ${response.status()} ${await response.text()}`
    ).toBeTruthy();
  }
}

/**
 * Removes the pins.
 *
 * `agent_provider_defaults` rows are scoped by a plain `scope` text column
 * rather than a foreign key, so deleting the project does NOT cascade them —
 * they would outlive the run as rows naming a project that no longer exists.
 * That orphaning is a product gap worth its own ticket (the project delete
 * route unlinks uploads but never these rows); until it is closed, the suite
 * cleans up after itself rather than leaking a row per run.
 */
export async function unpinProjectAgents(
  request: APIRequestContext,
  projectId: string
): Promise<void> {
  for (const agentType of PINNED_AGENT_TYPES) {
    await request
      .delete(`/api/projects/${projectId}/agent-config/providers/${agentType}`)
      .catch(() => undefined);
  }
}

export const test = base.extend<{ project: ArijProject }>({
  project: async ({ request }, use, testInfo) => {
    const { rootPath, repoPath } = createScratchRepo();
    // `createProjectSchema` caps the name at 200 chars, and the worker index
    // keeps two parallel tests of the same title apart.
    const name = `E2E ${testInfo.title}`.slice(0, 180) + ` #${testInfo.workerIndex}`;

    const created = await withTransportRetry(() =>
      request.post("/api/projects", {
        data: { name, gitRepoPath: repoPath },
      })
    );
    expect(
      created.ok(),
      `project creation failed: ${created.status()} ${await created.text()}`
    ).toBeTruthy();

    const { data } = (await created.json()) as { data: { id: string } };
    const project: ArijProject = {
      id: data.id,
      name,
      repoPath,
      rootPath,
      boardUrl: `/projects/${data.id}`,
    };

    try {
      assertSharedDatabase(project.id);
      await use(project);
    } finally {
      // `finally`, so a failing test still gives its uploads back: the point of
      // the teardown is that running the suite leaves no residue either way.
      //
      // No `removeDirectory=true`: this project was never cloned by Arij, so the
      // route would decline anyway — the scratch repo is ours to remove.
      const deleted = await deleteProject(request, project.id);
      // The whole temp root, not just the repository: a build's worktree is
      // created beside it (see ArijProject.rootPath).
      rmSync(rootPath, { recursive: true, force: true });
      const residue = takeUploadResidue(project.id);

      // Asserted only once every removal above has run, so a teardown that
      // fails still fails clean.
      expect(
        deleted.ok,
        `DELETE /api/projects/${project.id} failed: ${deleted.detail}`
      ).toBe(true);
      expect(
        projectRowExists(project.id),
        `project ${project.id} is still in ${DATABASE_FILE} after a delete that reported success`
      ).toBe(false);
      expect(
        residue.rows,
        `the project delete left ${residue.rows} chat_attachments row(s) for ${project.id}`
      ).toBe(0);
      expect(
        residue.directory,
        `the project delete left ${path.join(DATA_ROOT, "uploads", project.id)} on disk`
      ).toBe(false);
    }
  },
});

export { expect };
