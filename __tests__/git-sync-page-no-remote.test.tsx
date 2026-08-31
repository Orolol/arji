import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import GitSyncPage from "@/app/projects/[projectId]/git-sync/page";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

vi.mock("@/hooks/useNamedAgentsList", () => ({
  useNamedAgentsList: () => ({ agents: [], loading: false }),
}));

vi.mock("@/components/shared/NamedAgentSelect", () => ({
  NamedAgentSelect: () => <div data-testid="named-agent-select" />,
}));

vi.mock("@/components/shared/SessionPicker", () => ({
  SessionPicker: () => <div data-testid="session-picker" />,
}));

interface StatusData {
  branch: string;
  remote: string;
  ahead: number;
  behind: number;
  hasRemoteBranch: boolean;
  remoteConfigured?: boolean | null;
  configuredRemotes?: string[] | null;
  remoteFetchConfigured?: boolean | null;
  remotePushConfigured?: boolean | null;
  fetchRemotes?: string[] | null;
  pushRemotes?: string[] | null;
}

/**
 * Serves the status route from `nextStatus()` (re-read on every call, so a
 * test can change what the server reports between mounts) plus the worktrees
 * column, and records every request the page makes.
 */
function mockPageFetch(
  nextStatus: () => StatusData,
  extra?: (url: string, init?: RequestInit) => Response | undefined
) {
  const calls: Array<{ url: string; method: string | undefined }> = [];

  vi.spyOn(global, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = String(input);
    calls.push({ url, method: init?.method });

    const handled = extra?.(url, init);
    if (handled) return handled;

    if (url.includes("/worktrees")) {
      return {
        ok: true,
        json: async () => ({ data: { worktrees: [], count: 0, orphanCount: 0 } }),
      } as Response;
    }

    const data = nextStatus();
    return { ok: true, json: async () => ({ data }) } as Response;
  }) as unknown as typeof fetch);

  return calls;
}

const CONFIGURED: StatusData = {
  branch: "main",
  remote: "origin",
  ahead: 0,
  behind: 0,
  hasRemoteBranch: true,
  remoteConfigured: true,
  configuredRemotes: ["origin"],
  remoteFetchConfigured: true,
  remotePushConfigured: true,
  fetchRemotes: ["origin"],
  pushRemotes: ["origin"],
};

function unconfigured(configuredRemotes: string[] = []): StatusData {
  return {
    ...CONFIGURED,
    hasRemoteBranch: false,
    remoteConfigured: false,
    configuredRemotes,
    remoteFetchConfigured: false,
    remotePushConfigured: false,
    fetchRemotes: configuredRemotes,
    pushRemotes: configuredRemotes,
  };
}

describe("GitSyncPage with no usable remote", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("explains the missing remote and blocks the actions that cannot work", async () => {
    mockPageFetch(() => unconfigured());

    render(<GitSyncPage />);

    await waitFor(() => {
      expect(screen.getByTestId("git-remote-missing")).toBeInTheDocument();
    });
    expect(screen.getByText("No remote to sync with")).toBeInTheDocument();
    expect(screen.getByTestId("git-remote-add-hint")).toHaveTextContent(
      "git remote add origin"
    );
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
  });

  it("offers the remotes the repository actually has as a one-click recovery", async () => {
    const user = userEvent.setup();
    const calls = mockPageFetch(() => unconfigured(["upstream"]));

    render(<GitSyncPage />);

    await waitFor(() => {
      expect(screen.getByTestId("use-remote-upstream")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("git-remote-add-hint")).toBeNull();

    await user.click(screen.getByTestId("use-remote-upstream"));

    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.url.includes("/git/status") && call.url.includes("remote=upstream")
        )
      ).toBe(true);
    });
  });

  it("re-derives the affordance on a fresh mount, not from a held response", async () => {
    mockPageFetch(() => unconfigured());

    const first = render(<GitSyncPage />);
    await waitFor(() => {
      expect(screen.getByTestId("git-remote-missing")).toBeInTheDocument();
    });

    // A refresh / remount keeps nothing in component state: the panel has to
    // come back from the server's own view of the repository.
    first.unmount();
    render(<GitSyncPage />);

    await waitFor(() => {
      expect(screen.getByTestId("git-remote-missing")).toBeInTheDocument();
    });
  });

  it("shows no missing-remote panel when the remote is configured", async () => {
    mockPageFetch(() => CONFIGURED);

    render(<GitSyncPage />);

    await waitFor(() => {
      expect(screen.getByText("Ahead")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("git-remote-missing")).toBeNull();
    expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
  });

  it("disables only Pull and explains a push-only remote from status state", async () => {
    mockPageFetch(() => ({
      ...CONFIGURED,
      hasRemoteBranch: false,
      remoteFetchConfigured: false,
      remotePushConfigured: true,
      fetchRemotes: [],
      pushRemotes: ["origin"],
    }));

    render(<GitSyncPage />);

    await waitFor(() => {
      expect(screen.getByTestId("git-remote-fetch-missing")).toBeInTheDocument();
    });
    expect(screen.getByText("No remote to pull from")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
  });

  it("surfaces a mid-session 409 by re-reading the server state", async () => {
    const user = userEvent.setup();
    // The remote disappears after the page has already loaded a good status.
    let status: StatusData = CONFIGURED;

    mockPageFetch(
      () => status,
      (url) => {
        if (!url.includes("/git/push")) return undefined;
        status = unconfigured();
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: "No git remote named 'origin' is configured for this repository.",
            code: "remote_not_configured",
            remote: "origin",
            configuredRemotes: [],
          }),
        } as Response;
      }
    );

    render(<GitSyncPage />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
    });

    await user.click(screen.getByRole("button", { name: "Push" }));

    await waitFor(() => {
      expect(screen.getByTestId("git-remote-missing")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "No git remote named 'origin' is configured for this repository."
      )
    ).toBeInTheDocument();
  });
});
