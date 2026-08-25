import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewProjectPage from "@/app/projects/new/page";

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
}));

function fillAndSubmit(name = "Arij") {
  fireEvent.change(screen.getByPlaceholderText("My Awesome Project"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create Project" }));
}

describe("new project page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the API error instead of silently doing nothing", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "Path does not exist or is not accessible" }),
    })) as unknown as typeof fetch;

    render(<NewProjectPage />);
    fillAndSubmit();

    expect(
      await screen.findByText("Path does not exist or is not accessible")
    ).toBeInTheDocument();
    expect(nav.push).not.toHaveBeenCalled();
    // The button is usable again, not stuck on "Creating...".
    expect(screen.getByRole("button", { name: "Create Project" })).toBeEnabled();
  });

  it("falls back to the status code when the API sends no message", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    render(<NewProjectPage />);
    fillAndSubmit();

    expect(
      await screen.findByText("Failed to create project (HTTP 500)")
    ).toBeInTheDocument();
  });

  it("reports a network failure", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("Failed to fetch");
    }) as unknown as typeof fetch;

    render(<NewProjectPage />);
    fillAndSubmit();

    expect(await screen.findByText("Failed to fetch")).toBeInTheDocument();
  });

  it("still navigates on success", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { id: "proj-9" } }),
    })) as unknown as typeof fetch;

    render(<NewProjectPage />);
    fillAndSubmit();

    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith("/projects/proj-9")
    );
    expect(screen.queryByText(/Failed to create/)).not.toBeInTheDocument();
  });
});
