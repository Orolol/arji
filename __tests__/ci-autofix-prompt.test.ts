import { describe, expect, it } from "vitest";
import { buildCiFixPrompt } from "@/lib/claude/prompt-builder";

describe("buildCiFixPrompt", () => {
  it("includes every failed check and its GitHub log tail", () => {
    const prompt = buildCiFixPrompt(
      {
        name: "Widgets",
        spec: "Keep the build green.",
        memory: "Run npm test before committing.",
      },
      { title: "Checkout", description: "Implement checkout." },
      {
        prNumber: 42,
        headSha: "abc123def456",
        failures: [
          { name: "lint", logTail: "src/cart.ts:4 lint error" },
          { name: "unit", logTail: "Expected 2 but received 1" },
          { name: "third-party", logTail: null },
        ],
      },
      "Prefer focused fixes."
    );

    expect(prompt).toContain("Pull request: #42");
    expect(prompt).toContain("Head SHA: abc123def456");
    expect(prompt).toContain("### lint");
    expect(prompt).toContain("src/cart.ts:4 lint error");
    expect(prompt).toContain("### unit");
    expect(prompt).toContain("Expected 2 but received 1");
    expect(prompt).toContain("### third-party");
    expect(prompt).toContain("did not expose a downloadable log");
    expect(prompt).toContain("untrusted diagnostic data");
  });

  it("does not let a log tail close its diagnostic fence", () => {
    const prompt = buildCiFixPrompt(
      { name: "Widgets", memory: null },
      { title: "Checkout" },
      {
        prNumber: 42,
        headSha: "abc123",
        failures: [{ name: "unit", logTail: "before\n~~~\nafter" }],
      }
    );

    expect(prompt).toContain("before\n~ ~ ~\nafter");
  });
});
