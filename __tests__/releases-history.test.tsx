import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
}));

const ghConfig = vi.hoisted(() => ({
  isConfigured: true,
  ownerRepo: "orolol/arij" as string | null,
  tokenSet: true,
  loading: false,
}));
vi.mock("@/hooks/useGitHubConfig", () => ({
  useGitHubConfig: () => ghConfig,
}));

const git = vi.hoisted(() => ({
  ahead: 0,
  behind: 0,
  lastFetchedAt: null as number | null,
  lastFetchError: null as string | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  push: vi.fn(async () => {}),
  pushing: false,
}));
vi.mock("@/hooks/useGitStatus", () => ({ useGitStatus: () => git }));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: () => ({
    worktrees: [],
    count: null,
    orphanCount: 0,
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
    pruning: false,
  }),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false, refresh: vi.fn() }),
}));

const publishState = vi.hoisted(() => ({
  publish: vi.fn(async () => true),
  isPublishing: false,
  error: null as string | null,
}));
vi.mock("@/hooks/useReleasePublish", () => ({
  useReleasePublish: () => publishState,
}));

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <button type="button">agent</button>,
}));
vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: () => <button type="button">session</button>,
}));

import ReleasesPage from "@/app/projects/[projectId]/releases/page";

const DAY = 24 * 60 * 60 * 1000;

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

const PROJECT = {
  id: "p1",
  name: "Arij",
  defaultBranch: "main",
  gitRepoPath: "/repo",
  githubOwnerRepo: "orolol/arij",
};

/** Published: a GitHub id AND a push. Carries a tag, and one id whose epic is gone. */
const PUBLISHED = {
  id: "r1",
  version: "0.4.2",
  title: null,
  changelog: "# 0.4.2\n\n## Features\n- Session artifact gallery\n",
  epicIds: '["e3","gone1234567"]',
  releaseBranch: "release/v0.4.2",
  gitTag: "v0.4.2",
  githubReleaseId: 10,
  githubReleaseUrl: "https://github.com/orolol/arij/releases/10",
  pushedAt: iso(4 * DAY),
  createdAt: iso(4 * DAY),
};

/** Local: a tag, no GitHub release at all, and no recorded tickets. */
const LOCAL = {
  id: "r2",
  version: "0.4.1",
  title: null,
  changelog: null,
  epicIds: null,
  releaseBranch: "release/v0.4.1",
  gitTag: "v0.4.1",
  githubReleaseId: null,
  githubReleaseUrl: null,
  pushedAt: null,
  createdAt: iso(14 * DAY),
};

/** Draft: a GitHub id but no push, and no tag. */
const DRAFT = {
  id: "r3",
  version: "0.4.0",
  title: null,
  changelog: "# 0.4.0\n\n## Features\n- Provider matrix doc\n\n### Notes\n- rien\n",
  epicIds: '["e5"]',
  releaseBranch: null,
  gitTag: null,
  githubReleaseId: 9,
  githubReleaseUrl: null,
  pushedAt: null,
  createdAt: iso(31 * DAY),
};

const EPICS = [
  {
    id: "e3",
    title: "Session artifact gallery",
    status: "done",
    type: "feature",
    readableId: "ARJ-96",
    releaseId: "r1",
    usCount: 1,
    usDone: 1,
    updatedAt: iso(4 * DAY),
  },
  {
    id: "e5",
    title: "Provider matrix doc",
    status: "done",
    type: "feature",
    readableId: "ARJ-90",
    releaseId: "r3",
    usCount: 1,
    usDone: 1,
    updatedAt: iso(31 * DAY),
  },
];

const state = vi.hoisted(() => ({
  releases: [] as Record<string, unknown>[],
  epics: [] as Record<string, unknown>[],
}));

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url === "/api/projects/p1/releases") return jsonRes({ data: state.releases });
  if (url === "/api/projects/p1/epics") return jsonRes({ data: state.epics });
  if (url === "/api/projects/p1") return jsonRes({ data: PROJECT });
  return jsonRes({ data: null });
});

async function renderPage() {
  const result = render(<ReleasesPage />);
  await waitFor(() =>
    expect(screen.getByTestId("release-stat-shipped").textContent).not.toContain(
      "—"
    )
  );
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.releases = [PUBLISHED, LOCAL, DRAFT];
  state.epics = EPICS;
  ghConfig.isConfigured = true;
  publishState.error = null;
  publishState.isPublishing = false;
  publishState.publish.mockResolvedValue(true);
  vi.stubGlobal("fetch", fetchMock);
  if (!globalThis.crypto?.randomUUID) {
    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      randomUUID: () => Math.random().toString(36).slice(2),
    });
  }
});

describe("Release history — stamps", () => {
  it("carries the state in the word, on one shared pool ground", async () => {
    await renderPage();

    const published = screen.getByTestId("release-history-row-r1");
    expect(within(published).getByText("TAG")).toBeInTheDocument();
    expect(within(published).getByText("GH RELEASE")).toBeInTheDocument();

    const local = screen.getByTestId("release-history-row-r2");
    expect(within(local).getByText("TAG")).toBeInTheDocument();
    expect(within(local).queryByText("GH RELEASE")).toBeNull();
    expect(within(local).queryByText("GH DRAFT")).toBeNull();

    const draft = screen.getByTestId("release-history-row-r3");
    expect(within(draft).queryByText("TAG")).toBeNull();
    expect(within(draft).getByText("GH DRAFT")).toBeInTheDocument();
  });

  it("prints the version and its ticket count", async () => {
    await renderPage();
    const row = screen.getByTestId("release-history-row-r1");
    expect(within(row).getByText("v0.4.2")).toBeInTheDocument();
    expect(within(row).getByText(/^2 tickets · /)).toBeInTheDocument();
    expect(
      within(screen.getByTestId("release-history-row-r3")).getByText(
        /^1 ticket · /
      )
    ).toBeInTheDocument();
  });
});

describe("Release history — expansion", () => {
  it("expands one row at a time and collapses on a second click", async () => {
    const user = userEvent.setup();
    await renderPage();

    const first = screen.getByTestId("release-history-row-r1");
    expect(first).toHaveAttribute("aria-expanded", "false");

    await user.click(first);
    expect(screen.getByTestId("release-history-row-r1")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(
      within(screen.getByTestId("release-history-tickets-r1")).getByText(
        "ARJ-96 · Session artifact gallery"
      )
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("release-history-row-r3"));
    expect(screen.getByTestId("release-history-row-r1")).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByTestId("release-history-tickets-r1")).toBeNull();
    expect(screen.getByTestId("release-history-tickets-r3")).toBeInTheDocument();

    await user.click(screen.getByTestId("release-history-row-r3"));
    expect(screen.queryByTestId("release-history-tickets-r3")).toBeNull();
  });

  it("renders a deleted epic's recorded id with an em-dash title", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId("release-history-row-r1"));
    expect(
      within(screen.getByTestId("release-history-tickets-r1")).getByText(
        "gone1234 · —"
      )
    ).toBeInTheDocument();
  });

  it("says so when a release recorded no tickets", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId("release-history-row-r2"));
    expect(
      within(screen.getByTestId("release-history-tickets-r2")).getByText(
        "no tickets recorded"
      )
    ).toBeInTheDocument();
  });
});

describe("Release history — inspect mode", () => {
  async function openInspect(releaseId: string) {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByTestId(`release-history-row-${releaseId}`));
    await user.click(
      within(
        screen.getByTestId(`release-history-tickets-${releaseId}`)
      ).getByText("voir le changelog →")
    );
    return user;
  }

  it("swaps the band to the release's changelog and back", async () => {
    const user = await openInspect("r1");

    expect(screen.getByText("Release")).toBeInTheDocument();
    expect(screen.queryByText("Next release")).toBeNull();
    expect(screen.getByTestId("release-changelog").textContent).toContain(
      "- Session artifact gallery"
    );
    expect(screen.getByTestId("release-version-pill").textContent).toBe("v0.4.2");
    expect(screen.getByText("published")).toBeInTheDocument();

    await user.click(screen.getByText("← revenir au brouillon"));
    expect(screen.getByText("Next release")).toBeInTheDocument();
  });

  it("offers View on GitHub only when the release has a URL", async () => {
    await openInspect("r1");
    expect(screen.getByTestId("release-view-on-github")).toHaveAttribute(
      "href",
      "https://github.com/orolol/arij/releases/10"
    );
  });

  it("does not offer Publish for a published release", async () => {
    await openInspect("r1");
    expect(screen.queryByTestId("release-publish-button")).toBeNull();
  });

  it("publishes a draft release and reloads on success", async () => {
    const user = await openInspect("r3");

    const publish = screen.getByTestId("release-publish-button");
    expect(publish).toBeInTheDocument();
    const loadsBefore = fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/api/projects/p1/epics"
    ).length;

    await user.click(publish);

    expect(publishState.publish).toHaveBeenCalledWith("r3");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => String(url) === "/api/projects/p1/epics"
        ).length
      ).toBe(loadsBefore + 1)
    );
  });

  it("renders a publish failure inline and does not reload", async () => {
    publishState.publish.mockResolvedValue(false);
    publishState.error = "Release already published";
    const user = await openInspect("r3");

    const loadsBefore = fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/api/projects/p1/epics"
    ).length;
    await user.click(screen.getByTestId("release-publish-button"));

    expect(screen.getByTestId("release-publish-error").textContent).toBe(
      "Release already published"
    );
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => String(url) === "/api/projects/p1/epics"
      ).length
    ).toBe(loadsBefore);
  });

  it("hides Publish when GitHub is not configured", async () => {
    ghConfig.isConfigured = false;
    await openInspect("r3");
    expect(screen.queryByTestId("release-publish-button")).toBeNull();
  });

  it("summarises the recorded tag and branch, dropping the null clauses", async () => {
    await openInspect("r1");
    expect(
      screen.getByText("2 tickets · tag v0.4.2 sur release/v0.4.2")
    ).toBeInTheDocument();
  });
});

describe("Release history — empty", () => {
  it("keeps the History label and says there are none yet", async () => {
    state.releases = [];
    await renderPage();

    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("No releases yet")).toBeInTheDocument();
    expect(screen.queryByTestId("release-history-list")).toBeNull();
  });
});
