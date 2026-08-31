import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  mockNextRequest,
  mockRouteContext,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

/**
 * Regression: "GitHub is not configured for this project" is an ordinary,
 * recoverable state, not a server fault. Both issue routes used to let the
 * bare Error escape into `errorResponse`, which answered 500 with nothing the
 * UI could branch on — while `epics/:epicId/pr` and `git/detect-remote`
 * already answered 400 for the very same condition.
 */
vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

/** Seeds the two `.get()` reads `assertGitHubIssuesConfigured` performs. */
function seedConfig(opts: { ownerRepo: string | null; pat: string | null }) {
  dbMockState.getQueue.push({
    id: "proj-1",
    name: "Arij",
    githubOwnerRepo: opts.ownerRepo,
  });
  dbMockState.getQueue.push(
    opts.pat === null ? null : { key: "github_pat", value: JSON.stringify(opts.pat) }
  );
}

describe("GitHub issue routes on an unconfigured project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
  });

  it("GET triage answers 400 with GITHUB_REPO_NOT_CONFIGURED instead of 500", async () => {
    seedConfig({ ownerRepo: null, pat: "ghp_token" });

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/issues/triage/route"
    );

    const res = await GET(
      mockNextRequest({
        url: "http://localhost/api/projects/proj-1/github/issues/triage",
      }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("GITHUB_REPO_NOT_CONFIGURED");
    expect(json.error).toMatch(/not configured/i);
  });

  it("POST sync answers 400 with the same code for the same condition", async () => {
    seedConfig({ ownerRepo: null, pat: "ghp_token" });

    const { POST } = await import(
      "@/app/api/projects/[projectId]/github/issues/sync/route"
    );

    const res = await POST(
      mockNextRequest({
        url: "http://localhost/api/projects/proj-1/github/issues/sync",
        method: "POST",
      }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("GITHUB_REPO_NOT_CONFIGURED");
    expect(json.error).toMatch(/not configured/i);
  });

  it("answers 400 with GITHUB_PAT_NOT_CONFIGURED when the repo is linked but no PAT is stored", async () => {
    seedConfig({ ownerRepo: "Orolol/arij", pat: null });

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/issues/triage/route"
    );

    const res = await GET(
      mockNextRequest({
        url: "http://localhost/api/projects/proj-1/github/issues/triage",
      }),
      mockRouteContext({ projectId: "proj-1" })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.code).toBe("GITHUB_PAT_NOT_CONFIGURED");
  });

  it("the triage answer does not depend on whether a background sync was due", async () => {
    // `isGitHubIssueSyncDue` is what used to gate the throw: with a recent
    // sync log the route skipped the sync entirely and answered 200 with an
    // empty list, so the same unconfigured project got two different answers.
    seedConfig({ ownerRepo: null, pat: "ghp_token" });
    dbMockState.getQueue.push({ createdAt: new Date().toISOString() });

    const { GET } = await import(
      "@/app/api/projects/[projectId]/github/issues/triage/route"
    );

    const res = await GET(
      mockNextRequest({
        url: "http://localhost/api/projects/proj-1/github/issues/triage",
      }),
      mockRouteContext({ projectId: "proj-1" })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("GITHUB_REPO_NOT_CONFIGURED");
  });

  it("syncProjectGitHubIssues throws a typed, coded error the routes can map", async () => {
    seedConfig({ ownerRepo: null, pat: "ghp_token" });

    const { syncProjectGitHubIssues } = await import("@/lib/github/issues");
    const { GitHubNotConfiguredError } = await import("@/lib/github/client");

    await expect(syncProjectGitHubIssues("proj-1")).rejects.toBeInstanceOf(
      GitHubNotConfiguredError
    );
  });
});
