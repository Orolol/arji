import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import GitHubIssuesPage from "@/app/projects/[projectId]/github-issues/page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
}));

/**
 * The label-mapping panel drives which GitHub labels become features or bugs.
 * Both inputs must carry their visible label as an accessible name.
 */
describe("GitHub issues label mapping accessibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation((async (
      input: RequestInfo | URL
    ) => {
      const url = String(input);
      if (url.includes("/github/label-mapping")) {
        return {
          ok: true,
          json: async () => ({
            data: { featureLabels: ["feature"], bugLabels: ["bug"] },
          }),
        } as Response;
      }
      if (url === "/api/settings") {
        return {
          ok: true,
          json: async () => ({ data: { github_pat: { hasToken: true } } }),
        } as Response;
      }
      if (url === "/api/projects/proj-1") {
        return {
          ok: true,
          json: async () => ({ data: { githubOwnerRepo: "Orolol/arij" } }),
        } as Response;
      }
      return { ok: true, json: async () => ({ data: [] }) } as Response;
    }) as typeof fetch);
  });

  it("names both label-mapping fields through their visible labels", async () => {
    render(<GitHubIssuesPage />);

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("feature, enhancement, epic")
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Feature labels (comma-separated)")).toBe(
      screen.getByPlaceholderText("feature, enhancement, epic")
    );
    expect(screen.getByLabelText("Bug labels (comma-separated)")).toBe(
      screen.getByPlaceholderText("bug, defect, error")
    );
  });

  it("exposes the mapping explanation as the fields' description", async () => {
    render(<GitHubIssuesPage />);

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("feature, enhancement, epic")
      ).toBeInTheDocument();
    });

    const description =
      "Configure which GitHub labels map to Feature (Epic) or Bug ticket types.";
    expect(
      screen.getByLabelText("Feature labels (comma-separated)")
    ).toHaveAccessibleDescription(description);
    expect(
      screen.getByLabelText("Bug labels (comma-separated)")
    ).toHaveAccessibleDescription(description);
  });
});
