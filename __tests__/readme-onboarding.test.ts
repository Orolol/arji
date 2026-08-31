import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf-8");

describe("README onboarding documentation", () => {
  it("describes the project purpose", () => {
    expect(readme).toContain("# Arij");
    // Invariants, not an exact tagline: Arij is local-first, AI-powered,
    // and orchestrates agents. The precise wording is free to evolve.
    expect(readme).toMatch(/local[- ]first/i);
    expect(readme).toMatch(/AI[- ]powered/i);
    expect(readme).toMatch(/orchestrat/i);
  });

  it("includes a technical stack overview", () => {
    expect(readme).toContain("## Tech Stack");
    expect(readme).toContain("Next.js 16");
    expect(readme).toContain("SQLite via better-sqlite3 + Drizzle ORM");
    expect(readme).toContain("Claude Code CLI (`claude`)");
  });

  it("includes a high-level architecture overview", () => {
    expect(readme).toContain("## Architecture");
    // The architecture section must still name the chat surface. It used to be
    // "Chat Panel" — a resizable side panel next to the kanban board. Chat is
    // a full route now (app/chat/page.tsx), so the assertion pins the current
    // name; the point of the case is unchanged, which is that the overview
    // says where chat lives.
    expect(readme).toContain("Chat page");
    expect(readme).toContain("worktree");
  });

  it("replaces the default create-next-app template", () => {
    expect(readme).not.toContain(
      "bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app)",
    );
  });
});
