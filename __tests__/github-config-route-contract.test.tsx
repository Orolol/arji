import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  dbMockState,
  resetDbMockState,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";
import { useGitHubConfig } from "@/hooks/useGitHubConfig";
import { GITHUB_PAT_SETTING_KEY } from "@/lib/github/client";

/**
 * Contract between `GET /api/settings` + `GET /api/projects/:id` and the one
 * hook that reads them, `useGitHubConfig`.
 *
 * Why this file exists. The route masks the PAT down to `{ hasToken: boolean }`
 * and the hook reads `data.github_pat.hasToken`. Both halves were already
 * covered -- `settings-route.test.ts` asserts what the route emits,
 * `use-github-config.test.ts` asserts what the hook does with a payload -- but
 * BOTH assert against a hand-written literal. Nothing tied the two together,
 * so when the mask was introduced the hook was updated (b71bc87) and the
 * page-level fixtures were not. `github-issues-page.test.tsx` then failed 3 of
 * its 5 tests for a week: the stale `{ github_pat: "tok" }` fixture made
 * `tokenSet` false, and the page rendered its "no PAT" shell instead of the
 * triage list. That was filed eight times as a page bug; it was fixture drift.
 *
 * These tests drive the hook from the REAL route handlers' responses, so the
 * masker and the reader cannot drift apart again without reddening. All three
 * consumers of the config (the GitHub issues page, the releases page and
 * RepoStrataBand) go through this hook, so pinning it here covers them.
 */
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

const SECRET = "ghp_super_secret_value";

/**
 * Answers the hook's two requests with what the real handlers actually return,
 * rather than with a literal that encodes today's guess about their shape.
 */
async function serveFromRealRoutes(opts: {
  pat: string | null;
  ownerRepo: string | null;
}) {
  const { GET: settingsGET } = await import("@/app/api/settings/route");
  const { GET: projectGET } = await import(
    "@/app/api/projects/[projectId]/route"
  );

  // `.all()` feeds the settings route, `.get()` feeds getProjectOr404 -- two
  // independent slots, so the hook's concurrent Promise.all cannot interleave
  // them.
  dbMockState.allRows =
    opts.pat === null
      ? []
      : [{ key: GITHUB_PAT_SETTING_KEY, value: JSON.stringify(opts.pat) }];
  dbMockState.getQueue = [
    { id: "proj-1", name: "Arij", githubOwnerRepo: opts.ownerRepo },
  ];

  return vi.spyOn(global, "fetch").mockImplementation((async (
    input: RequestInfo | URL
  ) => {
    const url = String(input);
    if (url === "/api/settings") return settingsGET();
    if (url === "/api/projects/proj-1") {
      return projectGET(mockNextRequest(), mockRouteContext({ projectId: "proj-1" }));
    }
    throw new Error(`Unexpected fetch in contract test: ${url}`);
  }) as unknown as typeof fetch);
}

describe("useGitHubConfig against the real settings/project routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    resetDbMockState();
  });

  it("reports a configured project from what the routes really return", async () => {
    await serveFromRealRoutes({ pat: SECRET, ownerRepo: "Orolol/arij" });

    const { result } = renderHook(() => useGitHubConfig("proj-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The assertion the hand-written fixtures could not make: a stored PAT and
    // a linked repo, routed through the real handlers, must arrive at the hook
    // as a configured state. Re-mask the PAT under a different key (or read a
    // different one) and this goes red.
    expect(result.current.tokenSet).toBe(true);
    expect(result.current.ownerRepo).toBe("Orolol/arij");
    expect(result.current.isConfigured).toBe(true);
  });

  it("still never ships the raw PAT to the client that reads it", async () => {
    await serveFromRealRoutes({ pat: SECRET, ownerRepo: "Orolol/arij" });

    const { GET: settingsGET } = await import("@/app/api/settings/route");
    const body = JSON.stringify(await (await settingsGET()).json());

    expect(body).not.toContain(SECRET);
  });

  it("reports no token when the stored PAT is blank", async () => {
    await serveFromRealRoutes({ pat: "", ownerRepo: "Orolol/arij" });

    const { result } = renderHook(() => useGitHubConfig("proj-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tokenSet).toBe(false);
    expect(result.current.isConfigured).toBe(false);
    expect(result.current.ownerRepo).toBe("Orolol/arij");
  });

  it("reports no repo when the project has no githubOwnerRepo", async () => {
    await serveFromRealRoutes({ pat: SECRET, ownerRepo: null });

    const { result } = renderHook(() => useGitHubConfig("proj-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tokenSet).toBe(true);
    expect(result.current.ownerRepo).toBeNull();
    expect(result.current.isConfigured).toBe(false);
  });
});
