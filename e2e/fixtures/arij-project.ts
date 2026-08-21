import { test as base, expect, type APIRequestContext } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  /** Path to navigate to for the kanban board. */
  boardUrl: string;
}

/**
 * `validatePath` (which `POST /api/projects` runs on `gitRepoPath`) requires an
 * existing directory, and the board's git surfaces expect a real repository
 * with a branch — hence the empty initial commit rather than a bare `mkdir`.
 */
function createScratchRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "arij-e2e-"));

  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.email=e2e@arij.local",
        "-c",
        "user.name=Arij E2E",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stdio: "ignore" }
    );

  git("init", "-b", "main");
  git("commit", "--allow-empty", "-m", "initial");

  return dir;
}

/**
 * Where the server under test keeps its database and uploads.
 *
 * Both `lib/db/index.ts` and the upload route resolve it from `process.cwd()`,
 * and Playwright spawns `next dev` from the directory holding the config — so
 * the runner and the server agree by construction. They only diverge when
 * `reuseExistingServer` picks up a dev server that was started from somewhere
 * else; `E2E_DATA_ROOT` is the way to say so.
 *
 * Anchored on this file (`<repo>/e2e/fixtures/`) rather than on
 * `testInfo.config.rootDir`, which Playwright resolves to the *test* directory.
 */
const DATA_ROOT = process.env.E2E_DATA_ROOT
  ? path.resolve(process.env.E2E_DATA_ROOT)
  : path.resolve(__dirname, "..", "..", "data");

const DATABASE_FILE = path.join(DATA_ROOT, "arij.db");

/** The dev server holds the same WAL database open, so writes may have to queue. */
function openDatabase(): Database.Database {
  const connection = new Database(DATABASE_FILE);
  connection.pragma("busy_timeout = 5000");
  return connection;
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
    `no Arij database at ${DATABASE_FILE}; point E2E_DATA_ROOT at the data directory of the server under test`
  ).toBe(true);

  const db = openDatabase();
  try {
    const row = db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    expect(
      row,
      `the project this fixture just created is absent from ${DATABASE_FILE}, so the server writes elsewhere; point E2E_DATA_ROOT at its data directory`
    ).toBeTruthy();
  } finally {
    db.close();
  }
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
  const db = openDatabase();
  try {
    const rows = (
      db
        .prepare("SELECT COUNT(*) AS count FROM chat_attachments WHERE file_path GLOB ?")
        .get(pattern) as { count: number }
    ).count;

    if (rows > 0) {
      db.prepare("DELETE FROM chat_attachments WHERE file_path GLOB ?").run(pattern);
    }

    return { rows, directory };
  } finally {
    db.close();
  }
}

/** Whether the project row survived its own delete. */
function projectRowExists(projectId: string): boolean {
  if (!existsSync(DATABASE_FILE)) return false;

  const db = openDatabase();
  try {
    return db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId) !== undefined;
  } finally {
    db.close();
  }
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
    const response = await request.delete(`/api/projects/${projectId}`);
    if (response.ok()) return { ok: true, detail: String(response.status()) };

    return { ok: false, detail: `${response.status()} ${await response.text()}` };
  } catch (error) {
    return { ok: false, detail: `request failed: ${String(error)}` };
  }
}

export const test = base.extend<{ project: ArijProject }>({
  project: async ({ request }, use, testInfo) => {
    const repoPath = createScratchRepo();
    // `createProjectSchema` caps the name at 200 chars, and the worker index
    // keeps two parallel tests of the same title apart.
    const name = `E2E ${testInfo.title}`.slice(0, 180) + ` #${testInfo.workerIndex}`;

    const created = await request.post("/api/projects", {
      data: { name, gitRepoPath: repoPath },
    });
    expect(
      created.ok(),
      `project creation failed: ${created.status()} ${await created.text()}`
    ).toBeTruthy();

    const { data } = (await created.json()) as { data: { id: string } };
    const project: ArijProject = {
      id: data.id,
      name,
      repoPath,
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
      rmSync(repoPath, { recursive: true, force: true });
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
