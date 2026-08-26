import "@testing-library/jest-dom/vitest";
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

/**
 * Every test file gets its own throwaway database.
 *
 * `lib/db` opens `<cwd>/data/arij.db` by default — the developer's real
 * board. A test that reaches the real module (an unmocked import, a detached
 * `vi.mock`) then runs its fixtures against it, and the suites that clear
 * tables in `beforeEach` empty it for good. Setup files run once per test
 * file, so this hands each file a private path before any module can open a
 * connection; `lib/db` refuses the default path under vitest anyway, so a
 * missed override fails loudly instead of quietly.
 */
const dbDir = mkdtempSync(path.join(os.tmpdir(), "arij-test-db-"));
process.env.ARIJ_DB_PATH = path.join(dbDir, "arij.db");

afterAll(() => {
  rmSync(dbDir, { recursive: true, force: true });
});
