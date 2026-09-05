import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import GitSyncPage from "@/app/projects/[projectId]/git-sync/page";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

/**
 * The remote and branch inputs decide what push and pull target. Both must be
 * reachable by their visible label.
 */
describe("Git sync settings accessibility", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          branch: "main",
          remote: "origin",
          ahead: 1,
          behind: 2,
          hasRemoteBranch: true,
        },
      }),
    } as Response);
  });

  it("names the remote and branch fields through their visible labels", async () => {
    render(<GitSyncPage />);

    await waitFor(() => {
      expect(screen.getByText("Ahead")).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Remote")).toHaveValue("origin");
    expect(screen.getByLabelText("Branch")).toHaveValue("main");
  });
});
