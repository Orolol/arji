import { describe, expect, it } from "vitest";
import { generatePrBody } from "@/lib/github/pull-requests";

describe("generatePrBody", () => {
  it("generates body with epic description and story checklist", () => {
    const epic = {
      title: "User Authentication",
      description: "Implement secure login and registration flow.",
    };
    const stories = [
      { title: "Login form with email/password", status: "done" },
      { title: "Registration with validation", status: "in_progress" },
      { title: "Password reset flow", status: "todo" },
    ];

    const body = generatePrBody(epic, stories);

    expect(body).toContain("## Summary");
    expect(body).toContain("Implement secure login and registration flow.");
    expect(body).toContain("## User Stories");
    expect(body).toContain("- [x] Login form with email/password");
    expect(body).toContain("- [ ] Registration with validation");
    expect(body).toContain("- [ ] Password reset flow");
  });

  it("generates body with fallback when no description", () => {
    const epic = {
      title: "Dark Mode",
      description: null,
    };
    const stories: { title: string; status: string | null }[] = [];

    const body = generatePrBody(epic, stories);

    expect(body).toContain("## Summary");
    expect(body).toContain("**Dark Mode**");
    expect(body).not.toContain("## User Stories");
  });

  it("handles stories with null status as unchecked", () => {
    const epic = {
      title: "Test Epic",
      description: "Description",
    };
    const stories = [{ title: "Story with null status", status: null }];

    const body = generatePrBody(epic, stories);

    expect(body).toContain("- [ ] Story with null status");
  });

  it("includes Arij attribution", () => {
    const epic = { title: "Test", description: "Test" };
    const body = generatePrBody(epic, []);

    expect(body).toContain("Arij");
  });
});
