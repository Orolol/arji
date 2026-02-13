import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GitHubConnectBanner } from "@/components/github/GitHubConnectBanner";

let detectResponse: Record<string, unknown> = {
  data: {
    detected: true,
    owner: "octocat",
    repo: "hello-world",
    ownerRepo: "octocat/hello-world",
  },
};
let detectStatus = 200;
let patchStatus = 200;
let patchResponse: Record<string, unknown> = { data: { id: "proj-1" } };
let patchCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  detectResponse = {
    data: {
      detected: true,
      owner: "octocat",
      repo: "hello-world",
      ownerRepo: "octocat/hello-world",
    },
  };
  detectStatus = 200;
  patchStatus = 200;
  patchResponse = { data: { id: "proj-1" } };
  patchCalls = [];
  window.localStorage.clear();

  global.fetch = vi
    .fn()
    .mockImplementation((url: string, opts?: RequestInit) => {
      if (opts?.method === "PATCH") {
        patchCalls.push(JSON.parse(String(opts.body)));
        return Promise.resolve({
          ok: patchStatus >= 200 && patchStatus < 300,
          status: patchStatus,
          json: () => Promise.resolve(patchResponse),
        });
      }

      if (url.endsWith("/github/detect")) {
        return Promise.resolve({
          ok: detectStatus >= 200 && detectStatus < 300,
          status: detectStatus,
          json: () => Promise.resolve(detectResponse),
        });
      }

      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
});

describe("GitHubConnectBanner", () => {
  it("shows banner only when gitRepoPath exists and githubOwnerRepo is missing", async () => {
    const { rerender } = render(
      <GitHubConnectBanner
        projectId="proj-1"
        gitRepoPath={null}
        githubOwnerRepo={null}
      />
    );

    expect(screen.queryByText(/Connect this project to/)).not.toBeInTheDocument();

    rerender(
      <GitHubConnectBanner
        projectId="proj-1"
        gitRepoPath="/repos/test"
        githubOwnerRepo="octocat/already-set"
      />
    );

    await waitFor(() => {
      expect(screen.queryByText(/Connect this project to/)).not.toBeInTheDocument();
    });

    rerender(
      <GitHubConnectBanner
        projectId="proj-1"
        gitRepoPath="/repos/test"
        githubOwnerRepo={null}
      />
    );

    expect(await screen.findByText(/Connect this project to/)).toBeInTheDocument();
  });

  it("connect action patches project githubOwnerRepo", async () => {
    const onConnected = vi.fn();
    render(
      <GitHubConnectBanner
        projectId="proj-1"
        gitRepoPath="/repos/test"
        githubOwnerRepo={null}
        onConnected={onConnected}
      />
    );

    await screen.findByText(/Connect this project to/);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => {
      expect(patchCalls).toContainEqual({
        githubOwnerRepo: "octocat/hello-world",
      });
    });
    expect(onConnected).toHaveBeenCalledWith("octocat/hello-world");
  });

  it("dismiss hides the banner without patching project metadata", async () => {
    render(
      <GitHubConnectBanner
        projectId="proj-1"
        gitRepoPath="/repos/test"
        githubOwnerRepo={null}
      />
    );

    await screen.findByText(/Connect this project to/);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(screen.queryByText(/Connect this project to/)).not.toBeInTheDocument();
    });
    expect(patchCalls).toHaveLength(0);
  });
});
