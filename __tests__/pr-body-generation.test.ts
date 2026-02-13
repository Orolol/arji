import { describe, it, expect, vi } from "vitest";

// We import from the pull-requests module but need to mock the Octokit parts.
// Since generatePrBody is a pure function, we can test it directly.
// We mock the client import to avoid DB access.
vi.mock("@/lib/github/client", () => ({
  getOctokit: vi.fn(),
}));

import { generatePrBody } from "@/lib/github/pull-requests";

describe("generatePrBody", () => {
  it("generates body with epic description and no stories", () => {
    const body = generatePrBody(
      { title: "My Epic", description: "A great feature" },
      []
    );

    expect(body).toContain("## Summary");
    expect(body).toContain("A great feature");
    expect(body).not.toContain("## User Stories");
  });

  it("generates body with user stories checklist", () => {
    const body = generatePrBody(
      { title: "My Epic", description: "Feature description" },
      [
        { title: "Implement login", status: "done" },
        { title: "Add validation", status: "in_progress" },
        { title: "Write tests", status: "todo" },
      ]
    );

    expect(body).toContain("## Summary");
    expect(body).toContain("Feature description");
    expect(body).toContain("## User Stories");
    expect(body).toContain("- [x] Implement login");
    expect(body).toContain("- [ ] Add validation");
    expect(body).toContain("- [ ] Write tests");
  });

  it("marks only done stories as checked", () => {
    const body = generatePrBody(
      { title: "Epic", description: "Desc" },
      [
        { title: "Story A", status: "done" },
        { title: "Story B", status: "review" },
        { title: "Story C", status: "done" },
      ]
    );

    const lines = body.split("\n");
    const checkboxLines = lines.filter((l) => l.startsWith("- ["));

    expect(checkboxLines).toHaveLength(3);
    expect(checkboxLines[0]).toBe("- [x] Story A");
    expect(checkboxLines[1]).toBe("- [ ] Story B");
    expect(checkboxLines[2]).toBe("- [x] Story C");
  });

  it("uses placeholder when epic has no description", () => {
    const body = generatePrBody(
      { title: "Empty Epic", description: null },
      []
    );

    expect(body).toContain("_No description provided._");
  });

  it("includes Arij attribution footer", () => {
    const body = generatePrBody(
      { title: "Epic", description: "Desc" },
      []
    );

    expect(body).toContain("Arij");
  });
});
