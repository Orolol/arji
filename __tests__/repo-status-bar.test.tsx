import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const config = vi.hoisted(() => ({
  isConfigured: true,
  ownerRepo: "owner/repo" as string | null,
  tokenSet: true,
  loading: false,
}));

vi.mock("@/hooks/useGitHubConfig", () => ({
  useGitHubConfig: () => config,
}));

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

import { RepoStatusBar } from "@/components/layout/RepoStatusBar";

const prs = { rows: [] as Array<Record<string, unknown>> };
const worktrees = {
  ok: true,
  payload: { worktrees: [], count: 3, orphanCount: 0 } as Record<
    string,
    unknown
  >,
};

/** Render and flush the PR fetch so its setState stays inside act(). */
async function renderBar(
  ownerRepo: string | null,
  gitRepoPath: string | null = "/home/user/repo",
  defaultBranch: string | null = null
) {
  const result = render(
    <RepoStatusBar
      projectId="p1"
      ownerRepo={ownerRepo}
      gitRepoPath={gitRepoPath}
      defaultBranch={defaultBranch}
    />
  );
  await act(async () => {});
  return result;
}

describe("RepoStatusBar", () => {
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
            worktrees.ok
              ? { data: worktrees.payload }
              : { error: "not a git repository" },
        };
      }
      return { ok: true, json: async () => ({ data: prs.rows }) };
    }) as unknown as typeof fetch;
  });

  it("renders nothing when the project has no local git repository", () => {
    config.isConfigured = false;
    config.ownerRepo = null;

    const { container } = render(
      <RepoStatusBar projectId="p1" ownerRepo={null} gitRepoPath={null} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("repo-status-bar")).not.toBeInTheDocument();
  });

  it("renders the local git state even when GitHub is not connected", async () => {
    // The PAT only unlocks the PR pills — ahead/behind/worktrees/fetch/push
    // are plain local git and must not disappear with the token.
    config.isConfigured = false;
    config.tokenSet = false;

    await renderBar("owner/repo");

    expect(screen.getByTestId("repo-status-bar")).toBeInTheDocument();
    expect(screen.getByTestId("repo-ahead")).toHaveTextContent("↑ 2 to push");
    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls.some((call) => String(call[0]).includes("/prs"))).toBe(false);
  });

  it("labels the bar with the repo directory when GitHub is unknown", async () => {
    config.isConfigured = false;
    config.ownerRepo = null;
    config.tokenSet = false;

    await renderBar(null, "/home/user/my-project");

    expect(screen.getByText("my-project")).toBeInTheDocument();
  });

  it("shows the repo, the pinned branch and the last fetch time", async () => {
    git.lastFetchedAt = Date.now() - 2 * 60 * 1000;

    await renderBar("owner/repo");

    expect(screen.getByTestId("repo-status-bar")).toBeInTheDocument();
    expect(screen.getByText("owner/repo")).toBeInTheDocument();
    expect(screen.getByText(/main · fetched 2m ago/)).toBeInTheDocument();
  });

  it("says so honestly when the repo has never been fetched", async () => {
    git.lastFetchedAt = null;

    await renderBar("owner/repo");

    expect(screen.getByText("main · never fetched")).toBeInTheDocument();
  });

  it("reads the branch from the project's stored default branch", async () => {
    await renderBar("owner/repo", "/home/user/repo", "develop");

    expect(screen.getByText(/develop · never fetched/)).toBeInTheDocument();
    // ahead/behind is resolved — and pushed — against the stored branch.
    expect(git.calls[0]).toEqual(["p1", "develop", true]);
    expect(screen.getByTestId("repo-push-button")).toHaveTextContent(
      "Push develop"
    );
  });

  it("surfaces the git status error instead of a stale bar", async () => {
    // The hook resolves ahead/behind against this branch; when it cannot
    // (branch missing locally, git unreadable) the bar must say why instead
    // of silently showing zeros.
    git.error = "Local branch 'main' was not found.";

    await renderBar("owner/repo");

    expect(screen.getByTestId("repo-status-error")).toHaveTextContent(
      "Local branch 'main' was not found."
    );
    expect(screen.queryByText(/main · never fetched/)).not.toBeInTheDocument();
  });

  it("reads ahead/behind against main only", async () => {
    git.ahead = 2;
    git.behind = 3;

    await renderBar("owner/repo");

    expect(screen.getByTestId("repo-ahead")).toHaveTextContent("↑ 2 to push");
    expect(screen.getByTestId("repo-behind")).toHaveTextContent("↓ 3 behind");
    expect(git.calls[0]).toEqual(["p1", "main", true]);
  });

  it("counts the agent worktrees next to the ahead/behind counters", async () => {
    worktrees.payload = { worktrees: [], count: 3, orphanCount: 1 };

    await renderBar("owner/repo");

    await waitFor(() => {
      expect(screen.getByTestId("repo-worktrees")).toHaveTextContent(
        "3 worktrees"
      );
    });
    expect(global.fetch).toHaveBeenCalledWith("/api/projects/p1/worktrees");
  });

  it("singularizes the worktree counter", async () => {
    worktrees.payload = { worktrees: [], count: 1, orphanCount: 0 };

    await renderBar("owner/repo");

    await waitFor(() => {
      expect(screen.getByTestId("repo-worktrees")).toHaveTextContent(
        "1 worktree"
      );
    });
  });

  it("hides the worktree counter when the repo cannot be read", async () => {
    worktrees.ok = false;

    await renderBar("owner/repo");

    await waitFor(() => {
      expect(screen.getByTestId("repo-ahead")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("repo-worktrees")).not.toBeInTheDocument();
  });

  it("renders the open pull requests as pills", async () => {
    prs.rows = [
      { id: "pr1", number: 128, url: "https://gh/pr/128", status: "open" },
      { id: "pr2", number: 131, url: "https://gh/pr/131", status: "draft" },
    ];

    render(
      <RepoStatusBar
        projectId="p1"
        ownerRepo="owner/repo"
        gitRepoPath="/home/user/repo"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("#128")).toBeInTheDocument();
    });
    expect(screen.getByTestId("pr-badge-open")).toBeInTheDocument();
    expect(screen.getByTestId("pr-badge-draft")).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith("/api/projects/p1/prs");
  });

  it("fetches on demand and pushes main", async () => {
    const user = userEvent.setup();
    await renderBar("owner/repo");

    await user.click(screen.getByTestId("repo-fetch-button"));
    expect(git.refresh).toHaveBeenCalled();

    await user.click(screen.getByTestId("repo-push-button"));
    expect(git.push).toHaveBeenCalled();
  });

  it("disables Push main when there is nothing to push", async () => {
    git.ahead = 0;

    await renderBar("owner/repo");

    expect(screen.getByTestId("repo-push-button")).toBeDisabled();
  });

  it("disables Push main while a push is in flight", async () => {
    git.pushing = true;

    await renderBar("owner/repo");

    expect(screen.getByTestId("repo-push-button")).toBeDisabled();
  });

  it("never reports agent or session activity — that belongs to the board and Sessions tab", async () => {
    prs.rows = [
      { id: "pr1", number: 128, url: "https://gh/pr/128", status: "open" },
    ];

    render(
      <RepoStatusBar
        projectId="p1"
        ownerRepo="owner/repo"
        gitRepoPath="/home/user/repo"
      />
    );

    await waitFor(() => {
      expect(screen.getByText("#128")).toBeInTheDocument();
    });

    const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(
      calls.some((call) => String(call[0]).includes("/sessions"))
    ).toBe(false);
    expect(screen.getByTestId("repo-status-bar").textContent).not.toMatch(
      /agent|session/i
    );
  });

  it("falls back to the hook's repo when the layout has not resolved one yet", async () => {
    await renderBar(null);

    expect(screen.getByText("owner/repo")).toBeInTheDocument();
  });
});
