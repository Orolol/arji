/**
 * The project shell after the frame-13a retrofit.
 *
 * `app/projects/[projectId]/layout.tsx` used to draw a 54px header — project
 * name, Board/Spec/Sessions tabs, a "More" dropdown, and a right cluster of
 * New / Night run / Chat. The global top bar owns every navigational half of
 * that now, so the header is gone and this file's job changed with it:
 *
 *  - it asserts the chrome is GONE (no tabs, no More, no name heading), which
 *    is the whole point of the pass;
 *  - it keeps the New-menu and night-run wiring, which survived because those
 *    three controls push a `?panel=` / `?night=` param only the BOARD page
 *    consumes — so they are drawn on the board route and nowhere else;
 *  - it keeps the original chat-cutover assertion: the shell never fetches the
 *    legacy conversation list.
 */

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
      ok: true,
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
    // The shell's only load is the project summary; wait for it so the
    // repo-dependent controls have settled before anything is asserted.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/projects/proj-1");
    });
  }

  it("renders children and the connect banner", async () => {
    await renderLayout();

    expect(screen.getByTestId("project-content")).toBeInTheDocument();
    expect(screen.getByTestId("github-connect-banner")).toBeInTheDocument();
  });

  it("draws no header of its own — the global bar is the only one", async () => {
    await renderLayout();

    // The 54px bar and everything that lived in it.
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByText("Project One")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-nav-more")).not.toBeInTheDocument();
    for (const label of ["Board", "Spec & Memory", "Sessions"]) {
      expect(screen.queryByRole("link", { name: label })).not.toBeInTheDocument();
    }
    // Chat has the board's own collapsed strip; the duplicate pill is gone.
    expect(screen.queryByTestId("header-chat-button")).not.toBeInTheDocument();
  });

  it("does not fetch the conversation list the legacy chat pathway used", async () => {
    await renderLayout();

    expect(global.fetch).not.toHaveBeenCalledWith(
      "/api/projects/proj-1/conversations",
    );
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

  it("sends each New entry to the board panel it names", async () => {
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

  it("emits no agent-provider call when the manual epic entry is chosen", async () => {
    const user = userEvent.setup();
    await renderLayout();

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
  });

  it("starts a night run through the board URL param", async () => {
    const user = userEvent.setup();
    await renderLayout();

    await user.click(screen.getByTestId("night-run-button"));

    expect(nav.push).toHaveBeenCalledWith("/projects/proj-1?night=start");
  });

  it("keeps the arji.json sync action available", async () => {
    const user = userEvent.setup();
    await renderLayout();

    const sync = await screen.findByRole("button", {
      name: "Sync from arji.json",
    });
    await user.click(sync);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/projects/proj-1/sync",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("hides the sync action for a project with no repo on disk", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { name: "Project One" } }),
    });
    await renderLayout();

    await waitFor(() => {
      expect(screen.getByTestId("night-run-button")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Sync from arji.json" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the board-only controls off every other project route", async () => {
    nav.pathname = "/projects/proj-1/spec";
    await renderLayout();

    // Those three act by pushing a param only the board consumes, so drawing
    // them anywhere else would be a second bar that navigates away to work.
    expect(screen.queryByTestId("project-action-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("header-new-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("night-run-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-content")).toBeInTheDocument();
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
});
