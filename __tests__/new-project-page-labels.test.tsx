import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import NewProjectPage from "@/app/projects/new/page";

const nav = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, back: nav.back }),
}));

describe("new project form accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names every field through its visible label", () => {
    render(<NewProjectPage />);

    expect(screen.getByLabelText("Project Name *")).toBe(
      screen.getByPlaceholderText("My Awesome Project")
    );
    expect(screen.getByLabelText("Description")).toBe(
      screen.getByPlaceholderText("What is this project about?")
    );
    expect(screen.getByLabelText("Git Repository Path")).toBe(
      screen.getByPlaceholderText("/path/to/your/repo (optional)")
    );
  });

  it("drives the form through the labelled controls", () => {
    render(<NewProjectPage />);

    expect(screen.getByRole("button", { name: "Create Project" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Project Name *"), {
      target: { value: "Arij" },
    });
    expect(screen.getByRole("button", { name: "Create Project" })).toBeEnabled();
  });

  it("exposes the repository path hint as the field's description", () => {
    render(<NewProjectPage />);

    expect(screen.getByLabelText("Git Repository Path")).toHaveAccessibleDescription(
      "Path to an existing local git repository"
    );
  });

  it("announces a validation message when the required name is left empty", () => {
    render(<NewProjectPage />);
    const name = screen.getByLabelText("Project Name *");

    expect(name).not.toHaveAttribute("aria-invalid", "true");
    expect(
      screen.queryByText("Project name is required.")
    ).not.toBeInTheDocument();

    fireEvent.blur(name);

    const message = screen.getByText("Project name is required.");
    expect(message).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(/Project name is required\./);

    fireEvent.change(name, { target: { value: "Arij" } });
    expect(
      screen.queryByText("Project name is required.")
    ).not.toBeInTheDocument();
    expect(name).not.toHaveAttribute("aria-invalid", "true");
  });

  it("announces the submission error to assistive technology", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "Path does not exist or is not accessible" }),
    })) as unknown as typeof fetch;

    render(<NewProjectPage />);
    fireEvent.change(screen.getByLabelText("Project Name *"), {
      target: { value: "Arij" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Path does not exist or is not accessible");
  });
});
