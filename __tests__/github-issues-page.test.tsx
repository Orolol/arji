import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GitHubIssuesPage from "@/app/projects/[projectId]/github-issues/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

type IssueRow = {
  id: string;
  issueNumber: number;
  title: string;
  labels: string[];
  milestone: string | null;
  githubUrl: string;
  createdAtGitHub: string | null;
  importedEpicId: string | null;
};

/**
 * The page mounts several independent fetches (triage list, label mapping,
 * GitHub config for the repo context line), so route on the URL rather than on
 * call order.
 */
function mockFetchByUrl(options: {
  issues: IssueRow[];
  onImport?: () => void;
}) {
  return vi.spyOn(global, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = String(input);

    if (url.includes("/github/issues/triage")) {
      return { ok: true, json: async () => ({ data: options.issues }) } as Response;
    }
    if (url.includes("/github/issues/import")) {
      options.onImport?.();
      return {
        ok: true,
        status: 201,
        json: async () => ({
          data: { imported: [{ issueNumber: 42, epicId: "ep_9", type: "bug" }] },
        }),
      } as Response;
    }
    if (url.includes("/github/label-mapping")) {
      return {
        ok: true,
        json: async () => ({ data: { featureLabels: ["feature"], bugLabels: ["bug"] } }),
      } as Response;
    }
    if (url === "/api/settings") {
      return { ok: true, json: async () => ({ data: { github_pat: "tok" } }) } as Response;
    }
    if (url === "/api/projects/proj-1") {
      return {
        ok: true,
        json: async () => ({ data: { githubOwnerRepo: "Orolol/arij" } }),
      } as Response;
    }

    return { ok: true, json: async () => ({ data: [] }) } as Response;
  }) as typeof fetch);
}

/**
 * Fetch mock for a project that has no GitHub repository (and/or no PAT)
 * configured. Every request is recorded so the test can assert the page never
 * fires the triage request that used to answer 500.
 */
function mockUnconfiguredFetch(options: {
  ownerRepo?: string | null;
  pat?: string;
  /** Answer the triage route with the coded 4xx, for the late-config race. */
  triage?: { status: number; code: string; error: string };
}) {
  return vi.spyOn(global, "fetch").mockImplementation((async (
    input: RequestInfo | URL
  ) => {
    const url = String(input);

    if (url === "/api/settings") {
      return {
        ok: true,
        json: async () => ({ data: { github_pat: options.pat ?? "tok" } }),
      } as Response;
    }
    if (url === "/api/projects/proj-1") {
      return {
        ok: true,
        json: async () => ({
          data: { githubOwnerRepo: options.ownerRepo ?? null },
        }),
      } as Response;
    }
    if (url.includes("/github/issues/triage") && options.triage) {
      return {
        ok: false,
        status: options.triage.status,
        json: async () => ({
          error: options.triage!.error,
          code: options.triage!.code,
        }),
      } as Response;
    }
    if (url.includes("/github/label-mapping")) {
      return {
        ok: true,
        json: async () => ({
          data: { featureLabels: ["feature"], bugLabels: ["bug"] },
        }),
      } as Response;
    }

    return { ok: true, json: async () => ({ data: [] }) } as Response;
  }) as typeof fetch);
}

describe("GitHubIssuesPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders triage list and imported indicator", async () => {
    mockFetchByUrl({
      issues: [
        {
          id: "ghi_1",
          issueNumber: 11,
          title: "Feature issue",
          labels: ["feature"],
          milestone: "v1",
          githubUrl: "https://github.com/o/r/issues/11",
          createdAtGitHub: "2026-02-10T00:00:00Z",
          importedEpicId: "ep_1",
        },
      ],
    });

    render(<GitHubIssuesPage />);

    await waitFor(() => {
      expect(screen.getByText("GitHub Issue Triage")).toBeInTheDocument();
      expect(screen.getByText("imported")).toBeInTheDocument();
    });

    expect(screen.getByText("#11")).toBeInTheDocument();
    expect(screen.getByText("Feature issue")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
  });

  it("imports selected issues", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchByUrl({
      issues: [
        {
          id: "ghi_1",
          issueNumber: 42,
          title: "Bug issue",
          labels: ["bug"],
          milestone: null,
          githubUrl: "https://github.com/o/r/issues/42",
          createdAtGitHub: "2026-02-10T00:00:00Z",
          importedEpicId: null,
        },
      ],
    });

    render(<GitHubIssuesPage />);

    await waitFor(() => {
      expect(screen.getByText("Bug issue")).toBeInTheDocument();
    });
    expect(screen.getByText("to import")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select issue #42" }));
    await user.click(screen.getByRole("button", { name: /Import Selected/ }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/proj-1/github/issues/import",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("explains the missing repo instead of requesting triage, with zero console errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = mockUnconfiguredFetch({ ownerRepo: null });

    render(<GitHubIssuesPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/No GitHub repository is connected to this project/i)
      ).toBeInTheDocument();
    });

    // The whole point of the ticket: the page must not fire a request it
    // already knows cannot succeed.
    const triageCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/github/issues/triage")
    );
    expect(triageCalls).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
    expect(screen.queryByText("Loading issues...")).not.toBeInTheDocument();
  });

  it("explains a missing PAT rather than showing an empty issue list", async () => {
    mockUnconfiguredFetch({ ownerRepo: "Orolol/arij", pat: "" });

    render(<GitHubIssuesPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/No GitHub personal access token is stored/i)
      ).toBeInTheDocument();
    });
  });

  it("branches on the server's machine-readable code when the config is dropped mid-session", async () => {
    // The client-side gate and the server can disagree (the repo is unlinked
    // between the config read and the triage read), so the coded 4xx must
    // drive the same explanatory state rather than a red error line.
    mockUnconfiguredFetch({
      ownerRepo: "Orolol/arij",
      triage: {
        status: 400,
        code: "GITHUB_REPO_NOT_CONFIGURED",
        error: "GitHub repository is not configured for this project.",
      },
    });

    render(<GitHubIssuesPage />);

    await waitFor(() => {
      expect(
        screen.getByText(/No GitHub repository is connected to this project/i)
      ).toBeInTheDocument();
    });
  });
});
