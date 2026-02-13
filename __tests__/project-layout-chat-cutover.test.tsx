import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  usePathname: () => "/projects/proj-1",
}));

vi.mock("@/components/github/GitHubConnectBanner", () => ({
  GitHubConnectBanner: () => <div data-testid="github-connect-banner" />,
}));

import ProjectLayout from "@/app/projects/[projectId]/layout";

describe("project layout chat cutover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("removes the legacy right-side chat button and panel entry", async () => {
    render(
      <ProjectLayout>
        <div data-testid="project-content">content</div>
      </ProjectLayout>,
    );

    await waitFor(() => {
      expect(screen.getByText("Project One")).toBeInTheDocument();
    });

    expect(screen.queryByRole("button", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.getByTestId("project-content")).toBeInTheDocument();
    expect(screen.getByTestId("github-connect-banner")).toBeInTheDocument();
  });

  it("does not fetch conversation count for removed legacy chat pathways", async () => {
    render(
      <ProjectLayout>
        <div>content</div>
      </ProjectLayout>,
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/projects/proj-1");
    });

    expect(global.fetch).not.toHaveBeenCalledWith("/api/projects/proj-1/conversations");
  });
});
