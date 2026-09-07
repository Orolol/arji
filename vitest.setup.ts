import "@testing-library/jest-dom/vitest";
import { afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";

/**
 * next-intl without its provider.
 *
 * The real hooks need the context `app/layout.tsx` mounts once for the whole
 * app; component tests render below that layout. The stand-in resolves the
 * same catalogue with next-intl's own pure `createTranslator`, so rendered
 * copy is the app's English copy and a missing key throws. See
 * __tests__/support/next-intl-mock.ts for the contract and its limits; a test
 * that needs the real modules uses `vi.importActual`.
 */
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  const { buildNextIntlMock } = await import("./__tests__/support/next-intl-mock");
  return { ...actual, ...buildNextIntlMock(actual) };
});

vi.mock("next-intl/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl/server")>();
  const nextIntl = await vi.importActual<typeof import("next-intl")>("next-intl");
  const { buildNextIntlServerMock } = await import("./__tests__/support/next-intl-mock");
  return { ...actual, ...buildNextIntlServerMock(nextIntl) };
});

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
