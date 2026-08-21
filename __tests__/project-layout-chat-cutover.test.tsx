import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const nav = vi.hoisted(() => ({
  pathname: "/projects/proj-1",
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
}));

vi.mock("@/components/github/GitHubConnectBanner", () => ({
  GitHubConnectBanner: () => <div data-testid="github-connect-banner" />,
}));

// The repo bar is covered by its own test; stub it here so the layout test
// stays about the chrome and not about its pollers.
vi.mock("@/components/layout/RepoStatusBar", () => ({
  RepoStatusBar: ({ ownerRepo }: { ownerRepo: string | null }) => (
    <div data-testid="repo-status-bar" data-owner-repo={ownerRepo ?? ""} />
  ),
}));

import ProjectLayout from "@/app/projects/[projectId]/layout";

describe("project layout chrome", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    nav.pathname = "/projects/proj-1";
    nav.push = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          data: {
            name: "Project One",
            gitRepoPath: "/tmp/repo",
            githubOwnerRepo: "owner/repo",
          },
        }),
    });
  });

  async function renderLayout() {
    render(
      <ProjectLayout>
        <div data-testid="project-content">content</div>
      </ProjectLayout>,
    );
    await waitFor(() => {
      expect(screen.getByText("Project One")).toBeInTheDocument();
    });
  }

  it("renders the project name, children and the connect banner", async () => {
    await renderLayout();

    expect(screen.getByTestId("project-content")).toBeInTheDocument();
    expect(screen.getByTestId("github-connect-banner")).toBeInTheDocument();
  });

  it("routes the header Chat button to the board panel instead of opening a legacy panel", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await user.click(screen.getByTestId("header-chat-button"));

    expect(nav.push).toHaveBeenCalledWith("/projects/proj-1?panel=chat");
  });

  it("does not fetch conversation count for removed legacy chat pathways", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/projects/proj-1");
    });

    await user.click(screen.getByTestId("header-chat-button"));

    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/projects/proj-1/conversations",
    );
  });

  it("keeps the secondary pages reachable from the More menu", async () => {
    const user = userEvent.setup();
    await renderLayout();

    expect(screen.queryByRole("link", { name: /QA/i })).not.toBeInTheDocument();

    await user.click(screen.getByTestId("project-nav-more"));

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /QA/i })).toBeInTheDocument();
    });
    expect(screen.getByRole("menuitem", { name: /QA/i })).toHaveAttribute(
      "href",
      "/projects/proj-1/qa",
    );
    expect(screen.getByRole("menuitem", { name: /Git Sync/i })).toHaveAttribute(
      "href",
      "/projects/proj-1/git-sync",
    );
  });

  it("exposes the three primary tabs as links", async () => {
    await renderLayout();

    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute(
      "href",
      "/projects/proj-1",
    );
    expect(screen.getByRole("link", { name: "Spec" })).toHaveAttribute(
      "href",
      "/projects/proj-1/spec",
    );
    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      "/projects/proj-1/sessions",
    );
  });

  it("starts a night run through the board URL param", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await user.click(screen.getByTestId("night-run-button"));

    expect(nav.push).toHaveBeenCalledWith("/projects/proj-1?night=start");
  });

  it("offers manual epic, chat epic and bug in the New menu", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await user.click(screen.getByTestId("header-new-button"));

    await waitFor(() => {
      expect(screen.getByTestId("header-new-epic-manual")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("menuitem", { name: /New Epic \(manual\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /New Epic \(via chat\)/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /New Bug/i })).toBeInTheDocument();
  });

  it("opens the manual epic dialog through its own panel param", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await user.click(screen.getByTestId("header-new-button"));
    await waitFor(() => {
      expect(screen.getByTestId("header-new-epic-manual")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("header-new-epic-manual"));

    expect(nav.push).toHaveBeenCalledWith(
      "/projects/proj-1?panel=new-epic-manual",
    );
  });

  it("emits no agent-provider call when the manual epic entry is chosen", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/projects/proj-1");
    });
    (global.fetch as ReturnType<typeof vi.fn>).mockClear();

    await user.click(screen.getByTestId("header-new-button"));
    await waitFor(() => {
      expect(screen.getByTestId("header-new-epic-manual")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("header-new-epic-manual"));

    // The whole point of the manual entry is that it costs nothing: picking it
    // must stay a pure navigation. Asserting the exact call set rather than a
    // denylist of agent routes means any request added here — an agent warm-up,
    // a conversation prefetch, a model probe — fails this test.
    expect(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url),
    ).toEqual([]);
  });

  it("keeps the chat epic entry on the untouched new-epic panel", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await user.click(screen.getByTestId("header-new-button"));
    await waitFor(() => {
      expect(screen.getByTestId("header-new-epic-chat")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("header-new-epic-chat"));

    expect(nav.push).toHaveBeenCalledWith("/projects/proj-1?panel=new-epic");
  });

  it("opens the new-bug panel from the New menu", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await user.click(screen.getByTestId("header-new-button"));
    await waitFor(() => {
      expect(screen.getByTestId("header-new-bug")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("header-new-bug"));
    expect(nav.push).toHaveBeenCalledWith("/projects/proj-1?panel=new-bug");
  });

  it("sends every New menu entry to the board even from a secondary tab", async () => {
    // The menu lives in the chrome, which outlives the board page, so an entry
    // only works if it navigates to the *board* URL — nothing on Spec or
    // Sessions consumes ?panel=. Every other menu test runs at the board
    // pathname, where the current route and the board href are the same string,
    // so none of them can tell the two apart: routing through the pathname
    // instead leaves the manual entry silently dead on five of the eight tabs.
    nav.pathname = "/projects/proj-1/spec";
    const user = userEvent.setup();
    await renderLayout();

    for (const [testId, panel] of [
      ["header-new-epic-manual", "new-epic-manual"],
      ["header-new-epic-chat", "new-epic"],
      ["header-new-bug", "new-bug"],
    ]) {
      await user.click(screen.getByTestId("header-new-button"));
      await waitFor(() => {
        expect(screen.getByTestId(testId)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(testId));

      expect(nav.push).toHaveBeenCalledWith(`/projects/proj-1?panel=${panel}`);
    }
  });

  it("drives the New menu from the keyboard", async () => {
    const user = userEvent.setup();
    await renderLayout();

    screen.getByTestId("header-new-button").focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByTestId("header-new-epic-manual")).toBeInTheDocument();
    });

    // Radix focuses the first item on open; Escape must close without acting.
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByTestId("header-new-epic-manual"),
      ).not.toBeInTheDocument();
    });
    expect(nav.push).not.toHaveBeenCalled();

    // Reopen: Radix lands on the first item, so one ArrowDown reaches the
    // chat entry and Enter activates it — no pointer involved anywhere.
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("header-new-epic-manual")).toBeInTheDocument();
    });
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(nav.push).toHaveBeenCalledWith("/projects/proj-1?panel=new-epic");

    // And Enter straight after opening picks the manual entry.
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("header-new-epic-manual")).toBeInTheDocument();
    });
    await user.keyboard("{Enter}");

    expect(nav.push).toHaveBeenCalledWith(
      "/projects/proj-1?panel=new-epic-manual",
    );
  });

  it("mounts the repo bar on the board route only", async () => {
    await renderLayout();

    expect(screen.getByTestId("repo-status-bar")).toHaveAttribute(
      "data-owner-repo",
      "owner/repo",
    );
  });

  it("hides the repo bar on secondary pages", async () => {
    nav.pathname = "/projects/proj-1/sessions";
    await renderLayout();

    expect(screen.queryByTestId("repo-status-bar")).not.toBeInTheDocument();
  });

  it("keeps the arji.json sync action available", async () => {
    await renderLayout();

    const sync = screen.getByRole("button", { name: "Sync from arji.json" });
    expect(sync).toBeInTheDocument();
  });
});
