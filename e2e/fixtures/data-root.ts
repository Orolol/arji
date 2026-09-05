import Database from "better-sqlite3";
import path from "node:path";

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
export const DATA_ROOT = process.env.E2E_DATA_ROOT
  ? path.resolve(process.env.E2E_DATA_ROOT)
  : path.resolve(__dirname, "..", "..", "data");

/**
 * The database the server under test actually opens.
 *
 * `lib/db/index.ts` resolves it from `ARIJ_DB_PATH` when that is set and from
 * `<cwd>/data/arij.db` otherwise, and the same variable reaches the server
 * Playwright starts (its environment is the runner's, plus `webServer.env`) —
 * so the runner has to resolve it the same way or it reads a database nobody
 * is writing to. Uploads are NOT affected: the upload route builds
 * `data/uploads/<projectId>/` from the working directory whatever the database
 * path is, which is why `DATA_ROOT` stays separate.
 */
export const DATABASE_FILE = process.env.ARIJ_DB_PATH?.trim()
  ? path.resolve(process.env.ARIJ_DB_PATH.trim())
  : path.join(DATA_ROOT, "e2e.db");

/** The dev server holds the same WAL database open, so writes may have to queue. */
export function openDatabase(): Database.Database {
  const connection = new Database(DATABASE_FILE);
  connection.pragma("busy_timeout = 5000");
  return connection;
}

/**
 * Runs `read` against the server's database and always closes the handle.
 *
 * Every reader here is a few rows at most: the suite asserts on stored state
 * because the rendered board is not dependable evidence in the moments after a
 * write (B-arij-141), not because it wants a second implementation of the app.
 */
export function withDatabase<T>(read: (db: Database.Database) => T): T {
  const db = openDatabase();
  try {
    return read(db);
  } finally {
    db.close();
  }
}
