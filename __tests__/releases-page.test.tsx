import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
}));

const ghConfig = vi.hoisted(() => ({
  isConfigured: false,
  ownerRepo: null as string | null,
  tokenSet: false,
  loading: false,
}));
vi.mock("@/hooks/useGitHubConfig", () => ({
  useGitHubConfig: () => ghConfig,
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
}));
vi.mock("@/hooks/useGitStatus", () => ({ useGitStatus: () => git }));

const worktrees = vi.hoisted(() => ({
  worktrees: [],
  count: 5 as number | null,
  orphanCount: 0,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(async () => {}),
  prune: vi.fn(async () => {}),
  pruning: false,
}));
vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => worktrees }));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({
    agents: [{ id: "a1", name: "Scribe", provider: "claude" }],
    loading: false,
    refresh: vi.fn(),
  }),
}));

const publishState = vi.hoisted(() => ({
  publish: vi.fn(async () => true),
  isPublishing: false,
  error: null as string | null,
}));
vi.mock("@/hooks/useReleasePublish", () => ({
  useReleasePublish: () => publishState,
}));

/** Stubs for the two shared pickers: the popover's WIRING is what is under
 *  test here, not the pickers' own internals (they have their own suites). */
const agentSelect = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));
const sessionPicker = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: (props: { onChange: (id: string) => void }) => {
    agentSelect.props = props as unknown as Record<string, unknown>;
    return (
      <button
        type="button"
        data-testid="stub-named-agent"
        onClick={() => props.onChange("a1")}
      >
        agent
      </button>
    );
  },
}));

vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: (props: { onSelect: (id: string | undefined) => void }) => {
    sessionPicker.props = props as unknown as Record<string, unknown>;
    return (
      <button
        type="button"
        data-testid="stub-session-picker"
        onClick={() => props.onSelect("s1")}
      >
        session
      </button>
    );
  },
}));

import ReleasesPage from "@/app/projects/[projectId]/releases/page";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

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

const CLEAN_EPIC = {
  id: "e1",
  title: "Project rail: breathing dots per project",
  status: "done",
  type: "feature",
  readableId: "ARJ-107",
  releaseId: null,
  usCount: 2,
  usDone: 2,
  updatedAt: iso(2 * HOUR),
};

const DIRTY_EPIC = {
  id: "e2",
  title: "Dashboard band counters",
  status: "done",
  type: "feature",
  readableId: "ARJ-98",
  releaseId: null,
  usCount: 3,
  usDone: 1,
  updatedAt: iso(DAY),
};

const RELEASED_EPIC = {
  id: "e3",
  title: "Session artifact gallery",
  status: "done",
  type: "feature",
  readableId: "ARJ-96",
  releaseId: "r1",
  usCount: 1,
  usDone: 1,
  updatedAt: iso(4 * DAY),
};

const LATEST_RELEASE = {
  id: "r1",
  version: "0.4.2",
  title: null,
  changelog: "# 0.4.2\n\n## Features\n- Session artifact gallery\n",
  epicIds: '["e3"]',
  releaseBranch: "release/v0.4.2",
  gitTag: "v0.4.2",
  githubReleaseId: 10,
  githubReleaseUrl: "https://github.com/orolol/arij/releases/10",
  pushedAt: iso(4 * DAY),
  createdAt: iso(4 * DAY),
};

const state = vi.hoisted(() => ({
  releases: [] as Record<string, unknown>[],
  epics: [] as Record<string, unknown>[],
  project: {} as Record<string, unknown>,
  create: {
    ok: true,
    status: 201,
    body: {} as Record<string, unknown>,
  },
  hang: false,
}));

function jsonRes(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (state.hang) return new Promise<Response>(() => {});
  if (init?.method === "POST" && url === "/api/projects/p1/releases") {
    return {
      ok: state.create.ok,
      status: state.create.status,
      json: async () => state.create.body,
    } as unknown as Response;
  }
  if (url === "/api/projects/p1/releases") return jsonRes({ data: state.releases });
  if (url === "/api/projects/p1/epics") return jsonRes({ data: state.epics });
  if (url === "/api/projects/p1") return jsonRes({ data: state.project });
  return jsonRes({ data: null });
});

function postBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url) === "/api/projects/p1/releases" &&
      (init as RequestInit | undefined)?.method === "POST"
  );
  if (!call) throw new Error("no POST to /releases");
  return JSON.parse(String((call[1] as RequestInit).body));
}

/** Render and wait for the initial load to settle. */
async function renderPage() {
  const result = render(<ReleasesPage />);
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/p1/epics")
  );
  await waitFor(() =>
    expect(screen.getByTestId("release-stat-shipped").textContent).not.toContain(
      "—"
    )
  );
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.releases = [LATEST_RELEASE];
  state.epics = [CLEAN_EPIC, DIRTY_EPIC, RELEASED_EPIC];
  state.project = PROJECT;
  state.create = { ok: true, status: 201, body: { data: { release: {} } } };
  state.hang = false;
  ghConfig.isConfigured = false;
  ghConfig.loading = false;
  publishState.error = null;
  publishState.isPublishing = false;
  agentSelect.props = null;
  sessionPicker.props = null;
  vi.stubGlobal("fetch", fetchMock);
  if (!globalThis.crypto?.randomUUID) {
    vi.stubGlobal("crypto", {
      ...globalThis.crypto,
      randomUUID: () => Math.random().toString(36).slice(2),
    });
  }
});

describe("Releases screen — candidate tickets", () => {
  it("pre-checks a clean ticket and leaves a ticket with open stories out, with its reason", async () => {
    await renderPage();

    const clean = screen.getByTestId("release-ticket-row-e1");
    expect(within(clean).getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(within(clean).getByText(/^merged /)).toBeInTheDocument();

    const dirty = screen.getByTestId("release-ticket-row-e2");
    expect(within(dirty).getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "false"
    );
    expect(within(dirty).getByText("2 stories left")).toBeInTheDocument();
  });

  it("never offers a ticket that already belongs to a release", async () => {
    await renderPage();
    expect(screen.queryByTestId("release-ticket-row-e3")).toBeNull();
  });
});

describe("Releases screen — Create release", () => {
  it("is disabled with zero checked tickets and enabled with one", async () => {
    const user = userEvent.setup();
    await renderPage();

    const create = screen.getByTestId("release-create-button");
    expect(create).toBeEnabled();

    await user.click(
      within(screen.getByTestId("release-ticket-row-e1")).getByRole("checkbox")
    );
    expect(screen.getByTestId("release-create-button")).toBeDisabled();

    await user.click(
      within(screen.getByTestId("release-ticket-row-e2")).getByRole("checkbox")
    );
    expect(screen.getByTestId("release-create-button")).toBeEnabled();
  });

  it("POSTs the checked ids with generateChangelog and pushToGitHub false", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId("release-create-button"));

    await waitFor(() => expect(postBody).not.toThrow());
    expect(postBody()).toEqual({
      version: "0.4.3",
      epicIds: ["e1"],
      generateChangelog: true,
      pushToGitHub: false,
    });
  });

  it("raises an ERROR toast and still reloads when a 201 carries githubErrors", async () => {
    const user = userEvent.setup();
    state.create = {
      ok: true,
      status: 201,
      body: { data: { release: {}, githubErrors: ["Tag push failed: boom"] } },
    };
    await renderPage();
    const loadsBefore = fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/api/projects/p1/epics"
    ).length;

    await user.click(screen.getByTestId("release-create-button"));

    const toast = await screen.findByTestId("release-toast");
    expect(toast).toHaveAttribute("data-type", "error");
    expect(toast.textContent).toContain("created, but GitHub sync failed");
    expect(toast.textContent).toContain("Tag push failed: boom");

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => String(url) === "/api/projects/p1/epics"
        ).length
      ).toBe(loadsBefore + 1)
    );
  });

  it("raises a success toast when GitHub sync is clean", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId("release-create-button"));

    const toast = await screen.findByTestId("release-toast");
    expect(toast).toHaveAttribute("data-type", "success");
    expect(toast.textContent).toBe("Release v0.4.3 created");
  });

  it("toasts the server's error on a non-ok response", async () => {
    const user = userEvent.setup();
    state.create = {
      ok: false,
      status: 409,
      body: { error: "Version 0.4.3 already exists" },
    };
    await renderPage();

    await user.click(screen.getByTestId("release-create-button"));

    const toast = await screen.findByTestId("release-toast");
    expect(toast).toHaveAttribute("data-type", "error");
    expect(toast.textContent).toBe("Version 0.4.3 already exists");
  });
});

describe("Releases screen — GitHub draft toggle", () => {
  it("is absent when GitHub is not configured", async () => {
    await renderPage();
    expect(screen.queryByTestId("release-github-draft-toggle")).toBeNull();
  });

  it("is present when configured and flips pushToGitHub in the POST body", async () => {
    const user = userEvent.setup();
    ghConfig.isConfigured = true;
    await renderPage();

    const toggle = screen.getByTestId("release-github-draft-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);
    expect(screen.getByTestId("release-github-draft-toggle")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    await user.click(screen.getByTestId("release-create-button"));
    await waitFor(() => expect(postBody).not.toThrow());
    expect(postBody().pushToGitHub).toBe(true);
  });

  it("stays hidden while the GitHub config is still loading", async () => {
    ghConfig.isConfigured = true;
    ghConfig.loading = true;
    await renderPage();
    expect(screen.queryByTestId("release-github-draft-toggle")).toBeNull();
  });
});

describe("Releases screen — changelog agent", () => {
  it("clears the chosen resume session when the agent changes", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(
      within(screen.getByTestId("release-changelog-agent")).getByRole("button")
    );

    await user.click(await screen.findByTestId("stub-session-picker"));
    await waitFor(() =>
      expect(sessionPicker.props?.selectedSessionId).toBe("s1")
    );

    await user.click(screen.getByTestId("stub-named-agent"));
    await waitFor(() =>
      expect(sessionPicker.props?.selectedSessionId).toBeUndefined()
    );
    expect(sessionPicker.props?.agentType).toBe("release_notes");
  });
});

describe("Releases screen — stat tiles", () => {
  it("shows em-dashes while loading", async () => {
    state.hang = true;
    render(<ReleasesPage />);
    expect(screen.getByTestId("release-stat-current").textContent).toContain("—");
    expect(screen.getByTestId("release-stat-ready").textContent).toContain("—");
    expect(screen.getByTestId("release-stat-shipped").textContent).toContain("—");
  });

  it("shows the current version, the live ready count and the release count", async () => {
    const user = userEvent.setup();
    await renderPage();

    expect(screen.getByTestId("release-stat-current").textContent).toBe(
      "v0.4.2CURRENT · 4d AGO"
    );
    expect(screen.getByTestId("release-stat-ready").textContent).toBe(
      "1READY FOR v0.4.3"
    );
    expect(screen.getByTestId("release-stat-shipped").textContent).toBe(
      "1RELEASES SHIPPED"
    );

    await user.click(
      within(screen.getByTestId("release-ticket-row-e2")).getByRole("checkbox")
    );
    expect(screen.getByTestId("release-stat-ready").textContent).toBe(
      "2READY FOR v0.4.3"
    );
  });

  it("renders CURRENT with an em-dash and no age when there is no release", async () => {
    state.releases = [];
    await renderPage();
    expect(screen.getByTestId("release-stat-current").textContent).toBe(
      "—CURRENT"
    );
    expect(screen.getByTestId("release-stat-shipped").textContent).toBe(
      "0RELEASES SHIPPED"
    );
  });
});

describe("Releases screen — empty candidates", () => {
  it("collapses the band to its label line", async () => {
    state.epics = [RELEASED_EPIC];
    await renderPage();

    expect(screen.getByText("Next release")).toBeInTheDocument();
    expect(
      screen.getByText("No completed epics available for release")
    ).toBeInTheDocument();
    expect(screen.queryByTestId("release-changelog")).toBeNull();
    expect(screen.queryByTestId("release-create-button")).toBeNull();
  });
});

describe("Releases screen — header cluster", () => {
  it("renders the repo line, and uses its own testids", async () => {
    await renderPage();
    expect(screen.getByTestId("release-repo-line").textContent).toBe(
      "main · ↑ 2 to push · 5 worktrees"
    );
    expect(screen.getByTestId("release-push-button").textContent).toContain(
      "Push main"
    );
    expect(screen.queryByTestId("repo-fetch-button")).toBeNull();
  });

  it("refreshes git status AND worktrees on Fetch", async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId("release-fetch-button"));
    expect(git.refresh).toHaveBeenCalled();
    expect(worktrees.refresh).toHaveBeenCalled();
  });

  it("omits the worktree clause when the count is unknown", async () => {
    worktrees.count = null;
    await renderPage();
    expect(screen.getByTestId("release-repo-line").textContent).toBe(
      "main · ↑ 2 to push"
    );
    worktrees.count = 5;
  });
});

describe("Releases screen — changelog preview", () => {
  it("mirrors the server fallback for the checked tickets", async () => {
    await renderPage();
    const body = screen.getByTestId("release-changelog").textContent ?? "";
    expect(body).toContain("# 0.4.3");
    expect(body).toContain("## Features");
    expect(body).toContain("- Project rail: breathing dots per project");
    expect(body).toContain("## Bugfixes");
    expect(body).toContain("## Breaking Changes");
  });
});
