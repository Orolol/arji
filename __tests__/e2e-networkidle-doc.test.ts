import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/**
 * `networkidle` is a trap on every project-scoped page in this app.
 *
 * `app/projects/[projectId]/page.tsx` mounts `useProjectEvents`, which opens an
 * `EventSource` on `/api/projects/:id/events` and keeps it open for the life of
 * the page — the route holds the stream and writes a `: heartbeat` comment
 * every 30s, and the hook reconnects with backoff whenever it drops. Playwright
 * calls the page idle only after 500ms with no network connections, so that
 * request alone means it never does.
 *
 * The failure has no failed assertion attached to it: the test simply sits in
 * `goto`/`waitForLoadState` until the test timeout kills it (90s in dev mode
 * here). Nothing points at the SSE stream, so the natural reading is "the board
 * is slow" or "the fixture hung", and the next person reaches for a longer
 * timeout instead of a different wait.
 *
 * The suite is clean today and the README explains why. This test keeps both
 * halves true: the explanation stays in the README, and no spec reintroduces
 * the wait it warns about. It is a documentation lint on purpose — the artefact
 * being protected *is* the prose, because the pitfall costs a full test timeout
 * to rediscover.
 */

const E2E_DIR = join(__dirname, "..", "e2e");
const README = join(E2E_DIR, "README.md");

/** Every `.ts` file Playwright loads: specs plus the fixtures they import. */
function e2eSourceFiles(dir: string = E2E_DIR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    // `test-results/` is Playwright's output directory, not source.
    if (entry === "test-results") return [];
    if (statSync(full).isDirectory()) return e2eSourceFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

describe("e2e README documents the SSE/networkidle pitfall", () => {
  const readme = readFileSync(README, "utf8");

  it("names the wait that hangs", () => {
    expect(readme).toMatch(/networkidle/);
  });

  it("explains the cause: a Server-Sent Events stream held open by the page", () => {
    expect(readme).toMatch(/server-sent events|\bSSE\b/i);
    // The mechanism, not just the acronym: the stream outlives the load.
    expect(readme).toMatch(
      /(open|alive|held).{0,80}(life of the page|as long as the page|for the whole page|until the page)/is
    );
  });

  it("names the symptom, so a hung run is recognisable as this", () => {
    // "It times out" alone reads as slowness; the tell is that no assertion
    // failed.
    expect(readme).toMatch(/times? out|timeout/i);
    expect(readme).toMatch(/no failed assertion|without a failed assertion/i);
  });

  it("gives the alternative: domcontentloaded plus an explicit assertion", () => {
    expect(readme).toMatch(/domcontentloaded/);
    expect(readme).toMatch(/explicit.{0,40}(element|assertion)|assert.{0,40}element/is);
  });
});

describe("no e2e spec waits for networkidle", () => {
  const files = e2eSourceFiles();

  it("finds the spec files to scan", () => {
    // Guards the scan itself: an empty sweep would pass the check below while
    // proving nothing.
    expect(files.filter((f) => f.endsWith(".spec.ts")).length).toBeGreaterThan(0);
  });

  it.each(e2eSourceFiles().map((f) => [f.slice(E2E_DIR.length + 1), f]))(
    "%s",
    (_name, file) => {
      expect(readFileSync(file, "utf8")).not.toMatch(/networkidle/i);
    }
  );
});
