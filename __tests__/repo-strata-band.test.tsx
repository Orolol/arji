/**
 * Repository state on Git Sync.
 *
 * Replaces `repo-status-bar.test.tsx`: the pre-redesign `bg-sidebar` footer
 * moved to `/projects/:id/git-sync` as a stratum. Behaviour is carried over
 * unchanged with ONE deliberate difference — a project with no local
 * repository now names what is missing instead of rendering nothing, because
 * an empty dedicated page reads as a broken one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const config = vi.hoisted(() => ({
  isConfigured: true,
  ownerRepo: "owner/repo" as string | null,
  tokenSet: true,
  loading: false,
}));

vi.mock("@/hooks/useGitHubConfig", () => ({ useGitHubConfig: () => config }));

const git = vi.hoisted(() => ({
  ahead: 2,
  behind: 0,
  lastFetchedAt: null as number | null,
  lastFetchError: null as string | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  push: vi.fn(async () => {}),
  pushing: false,
  calls: [] as Array<[string, string | null, boolean]>,
}));

vi.mock("@/hooks/useGitStatus", () => ({
  useGitStatus: (projectId: string, branch: string | null, enabled: boolean) => {
    git.calls.push([projectId, branch, enabled]);
    return git;
  },
}));

import { RepoStrataBand } from "@/components/github/RepoStrataBand";

const prs = { rows: [] as Array<Record<string, unknown>> };
const worktrees = {
  ok: true,
  payload: { worktrees: [], count: 3, orphanCount: 0 } as Record<string, unknown>,
};

const band = () => document.querySelector('[data-slot="strata-band"]');

async function renderBand(
  ownerRepo: string | null,
  gitRepoPath: string | null = "/home/user/repo",
  defaultBranch: string | null = null,
) {
  const result = render(
    <RepoStrataBand
      projectId="p1"
      ownerRepo={ownerRepo}
      gitRepoPath={gitRepoPath}
      defaultBranch={defaultBranch}
    />,
  );
  await act(async () => {});
  return result;
}

describe("RepoStrataBand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.isConfigured = true;
    config.ownerRepo = "owner/repo";
    config.tokenSet = true;
    config.loading = false;
    git.ahead = 2;
    git.behind = 0;
    git.lastFetchedAt = null;
    git.loading = false;
    git.pushing = false;
    git.error = null;
    git.refresh = vi.fn();
    git.push = vi.fn(async () => {});
    git.calls = [];
    prs.rows = [];
    worktrees.ok = true;
    worktrees.payload = { worktrees: [], count: 3, orphanCount: 0 };

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/worktrees")) {
        return {
          ok: worktrees.ok,
          json: async () =>
            worktrees.ok ? { data: worktrees.payload } : { error: "not a git repository" },
        };
      }
      return { ok: true, json: async () => ({ data: prs.rows }) };
    }) as unknown as typeof fetch;
  });

  it("names the missing configuration instead of an error or an empty page", () => {
    config.isConfigured = false;
    config.ownerRepo = null;

    render(<RepoStrataBand projectId="p1" ownerRepo={null} gitRepoPath={null} />);

    const empty = screen.getByTestId("repo-not-configured");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toMatch(/no local git repository/i);
    // An explanatory empty state, not a failure.
    expect(band()!.textContent).not.toMatch(/error|failed/i);
    expect(screen.queryByTestId("repo-push-button")).not.toBeInTheDocument();
  });

  it("renders the local git state even when GitHub is not connected", async () => {
    // The PAT only unlocks the PR pills — ahead/behind/worktrees/fetch/push
    // are plain local git and must not disappear with the token.
    config.isConfigured = false;
    config.tokenSet = false;

    await renderBand("owner/repo");

    expect(screen.getByTestId("repo-ahead")).toHaveTextContent("↑ 2 to push");
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((call) => String(call[0]).includes("/prs"))).toBe(false);
  });

  it("labels the band with the repo directory when GitHub is unknown", async () => {
    config.isConfigured = false;
    config.ownerRepo = null;
    config.tokenSet = false;

    await renderBand(null, "/home/user/my-project");

    expect(screen.getByText("my-project")).toBeInTheDocument();
  });

  it("shows the repo, the pinned branch and the last fetch time", async () => {
    git.lastFetchedAt = Date.now() - 2 * 60 * 1000;
    await renderBand("owner/repo");

    expect(screen.getByText("owner/repo")).toBeInTheDocument();
    expect(screen.getByText(/main · fetched 2m ago/)).toBeInTheDocument();
  });

  it("says so honestly when the repo has never been fetched", async () => {
    await renderBand("owner/repo");
    expect(screen.getByText("main · never fetched")).toBeInTheDocument();
  });

  it("reads the branch from the project's stored default branch", async () => {
    await renderBand("owner/repo", "/home/user/repo", "develop");

    expect(screen.getByText(/develop · never fetched/)).toBeInTheDocument();
    expect(git.calls[0]).toEqual(["p1", "develop", true]);
    expect(screen.getByTestId("repo-push-button")).toHaveTextContent("Push develop");
  });

  it("surfaces the git status error instead of stale zeros", async () => {
    git.error = "Local branch 'main' was not found.";
    await renderBand("owner/repo");

    expect(screen.getByTestId("repo-status-error")).toHaveTextContent(
      "Local branch 'main' was not found.",
    );
    expect(screen.queryByText(/main · never fetched/)).not.toBeInTheDocument();
  });

  it("reads ahead/behind against the default branch only", async () => {
    git.ahead = 2;
    git.behind = 3;
    await renderBand("owner/repo");

    expect(screen.getByTestId("repo-ahead")).toHaveTextContent("↑ 2 to push");
    expect(screen.getByTestId("repo-behind")).toHaveTextContent("↓ 3 behind");
    expect(git.calls[0]).toEqual(["p1", "main", true]);
  });

  it("counts the agent worktrees next to the counters", async () => {
    worktrees.payload = { worktrees: [], count: 3, orphanCount: 1 };
    await renderBand("owner/repo");

    await waitFor(() =>
      expect(screen.getByTestId("repo-worktrees")).toHaveTextContent("3 worktrees"),
    );
    expect(global.fetch).toHaveBeenCalledWith("/api/projects/p1/worktrees");
  });

  it("singularizes the worktree counter", async () => {
    worktrees.payload = { worktrees: [], count: 1, orphanCount: 0 };
    await renderBand("owner/repo");

    await waitFor(() =>
      expect(screen.getByTestId("repo-worktrees")).toHaveTextContent("1 worktree"),
    );
  });

  it("hides the worktree counter when the repo cannot be read", async () => {
    worktrees.ok = false;
    await renderBand("owner/repo");

    await waitFor(() => expect(screen.getByTestId("repo-ahead")).toBeInTheDocument());
    expect(screen.queryByTestId("repo-worktrees")).not.toBeInTheDocument();
  });

  it("renders the open pull requests as pills", async () => {
    prs.rows = [
      { id: "pr1", number: 128, url: "https://gh/pr/128", status: "open" },
      { id: "pr2", number: 131, url: "https://gh/pr/131", status: "draft" },
    ];
    await renderBand("owner/repo");

    await waitFor(() => expect(screen.getByText("#128")).toBeInTheDocument());
    expect(screen.getByTestId("pr-badge-open")).toBeInTheDocument();
    expect(screen.getByTestId("pr-badge-draft")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("/api/projects/p1/prs");
  });

  it("fetches on demand and pushes the default branch", async () => {
    const user = userEvent.setup();
    await renderBand("owner/repo");

    await user.click(screen.getByTestId("repo-fetch-button"));
    expect(git.refresh).toHaveBeenCalled();

    await user.click(screen.getByTestId("repo-push-button"));
    expect(git.push).toHaveBeenCalled();
  });

  it("disables Push when there is nothing to push", async () => {
    git.ahead = 0;
    await renderBand("owner/repo");
    expect(screen.getByTestId("repo-push-button")).toBeDisabled();
  });

  it("disables Push while a push is in flight", async () => {
    git.pushing = true;
    await renderBand("owner/repo");
    expect(screen.getByTestId("repo-push-button")).toBeDisabled();
  });

  it("never reports agent or session activity — the desk owns that", async () => {
    prs.rows = [{ id: "pr1", number: 128, url: "https://gh/pr/128", status: "open" }];
    await renderBand("owner/repo");

    await waitFor(() => expect(screen.getByText("#128")).toBeInTheDocument());
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.some((call) => String(call[0]).includes("/sessions"))).toBe(false);
    expect(band()!.textContent).not.toMatch(/agent|session/i);
  });
});
