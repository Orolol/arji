import { NextRequest, NextResponse } from "next/server";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import {
  fetchGitRemote,
  getBranchSyncStatus,
  getCurrentGitBranch,
  getRemoteAvailability,
  type GitRemoteAvailability,
} from "@/lib/git/remote";

type Params = { params: Promise<{ projectId: string }> };

/**
 * How long a successful `git fetch` keeps the remote refs "fresh enough".
 * Without it, ahead/behind counters silently lie: nothing ever updates
 * `origin/*`, so "behind 0" really means "behind 0 as of the last manual
 * fetch, whenever that was".
 */
const FETCH_TTL_MS = 5 * 60 * 1000;

/**
 * Last SUCCESSFUL fetch timestamp (epoch ms) per `repoPath::remote`.
 *
 * Deliberately in-memory and module-level: no migration, no settings row, and
 * a dev hot-reload (or a server restart) simply resets it — worst case is one
 * extra fetch, which is cheap on a local repo.
 */
const lastFetchByRepo = new Map<string, number>();

interface FetchFreshness {
  /** Epoch ms of the last successful fetch, or null if we never got one. */
  lastFetchedAt: number | null;
  /** Set only on THIS response when the TTL fetch just failed. Not persisted. */
  lastFetchError: string | null;
}

/**
 * Fetches the remote when the cached refs are older than the TTL.
 *
 * Runs synchronously (a local `git fetch` is fast) but is strictly
 * best-effort: offline, no remote configured, or auth failure must never turn
 * a status read into a 500 — we keep serving the (possibly stale) counters and
 * surface `lastFetchError` instead.
 */
async function refreshRemoteIfStale(
  repoPath: string,
  remote: string
): Promise<FetchFreshness> {
  const key = `${repoPath}::${remote}`;
  const previous = lastFetchByRepo.get(key) ?? null;

  if (previous !== null && Date.now() - previous < FETCH_TTL_MS) {
    return { lastFetchedAt: previous, lastFetchError: null };
  }

  try {
    // Best-effort with a hard time bound: a black-holed network or hanging
    // SSH auth must not stall the status endpoint past the TTL refresh.
    await Promise.race([
      fetchGitRemote(repoPath, remote),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Fetch timed out.")), 4000)
      ),
    ]);
    const fetchedAt = Date.now();
    lastFetchByRepo.set(key, fetchedAt);
    return { lastFetchedAt: fetchedAt, lastFetchError: null };
  } catch (error) {
    return {
      lastFetchedAt: previous,
      lastFetchError:
        error instanceof Error
          ? error.message
          : "Failed to fetch from remote.",
    };
  }
}

export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(found)) return found;
  const { project } = found;

  const remote = request.nextUrl.searchParams.get("remote") || "origin";

  // Read the repository's remote list first. This is the state the Git Sync
  // page derives its "no remote to sync with" affordance from, so it has to
  // come back on every status read rather than only in a failed push/pull
  // response the client would lose on the next mount.
  let availability: GitRemoteAvailability | null = null;
  try {
    availability = await getRemoteAvailability(project.gitRepoPath, remote);
  } catch {
    // An unreadable remote list (bad path, flag-like remote name) is not a
    // precondition answer: leave it unknown rather than claiming the remote is
    // missing, and let the branch read below report the real failure.
    availability = null;
  }

  // Fetching a remote that does not exist can only produce a misleading
  // `lastFetchError`; the missing remote is the honest answer.
  const freshness =
    availability && !availability.fetchConfigured
      ? { lastFetchedAt: null, lastFetchError: null }
      : await refreshRemoteIfStale(project.gitRepoPath, remote);

  const requestedBranch = request.nextUrl.searchParams.get("branch")?.trim() || "";
  const branch = requestedBranch || (await getCurrentGitBranch(project.gitRepoPath));

  try {
    const status = await getBranchSyncStatus(project.gitRepoPath, branch, remote);
    return NextResponse.json({
      data: {
        action: "status",
        projectId,
        remote: status.remote,
        branch: status.branch,
        remoteBranch: status.remoteBranch,
        ahead: status.ahead,
        behind: status.behind,
        hasRemoteBranch: status.hasRemoteBranch,
        remoteConfigured: availability ? availability.configured : null,
        configuredRemotes: availability ? availability.configuredRemotes : null,
        remoteFetchConfigured: availability
          ? availability.fetchConfigured
          : null,
        remotePushConfigured: availability
          ? availability.pushConfigured
          : null,
        fetchRemotes: availability ? availability.fetchRemotes : null,
        pushRemotes: availability ? availability.pushRemotes : null,
        lastFetchedAt: freshness.lastFetchedAt,
        lastFetchError: freshness.lastFetchError,
      },
    });
  } catch (error) {
    return errorResponse(error, "Failed to read branch status.");
  }
}
