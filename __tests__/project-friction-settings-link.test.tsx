import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectFrictionLink } from "@/components/frictions/ProjectFrictionLink";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ProjectFrictionLink", () => {
  it("shows the open count in project settings and links to the inbox", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { openCount: 4, frictions: [] } }),
    }) as unknown as typeof fetch;

    render(<ProjectFrictionLink projectId="proj-1" />);

    expect(await screen.findByText("4 open")).toBeInTheDocument();
    expect(screen.getByTestId("project-frictions-settings-link"))
      .toHaveAttribute("href", "/projects/proj-1/frictions");
    expect(screen.getByLabelText("4 open frictions")).toBeInTheDocument();
  });
});
