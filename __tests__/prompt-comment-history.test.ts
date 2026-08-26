/**
 * Comment history in agent prompts.
 *
 * Review agents post their whole review document as a comment. Five passes on
 * one epic came to 71 KB — over half of a prompt that then died on the 128 KiB
 * argv cap. Only the most recent review belongs in the prompt; everything else
 * a ticket collected stays verbatim, and the elision is stated, not silent.
 */
import { describe, expect, it } from "vitest";
import {
  commentHistorySection,
  type PromptComment,
} from "@/lib/claude/prompt-builder";

function comment(
  content: string,
  overrides: Partial<PromptComment> = {},
): PromptComment {
  return {
    author: "agent",
    content,
    createdAt: "2026-08-25T10:00:00.000Z",
    ...overrides,
  };
}

const review = (content: string, type = "review_code") =>
  comment(content, { agentType: type });

describe("commentHistorySection", () => {
  it("returns nothing for a ticket with no comments", () => {
    expect(commentHistorySection([])).toBe("");
    expect(commentHistorySection(undefined)).toBe("");
  });

  it("keeps every comment when none came from a review agent", () => {
    const section = commentHistorySection([
      comment("Please use the existing helper.", { author: "user" }),
      comment("Build completed.", { agentType: "build" }),
    ]);

    expect(section).toContain("**User:**\nPlease use the existing helper.");
    expect(section).toContain("**Agent:**\nBuild completed.");
    expect(section).not.toContain("omitted");
  });

  it("keeps only the most recent review pass", () => {
    const section = commentHistorySection([
      review("First pass — many findings."),
      comment("Build completed.", { agentType: "build" }),
      review("Second pass — some fixed."),
      review("Third pass — ship it."),
    ]);

    expect(section).toContain("Third pass — ship it.");
    expect(section).not.toContain("First pass");
    expect(section).not.toContain("Second pass");
    expect(section).toContain("Build completed.");
  });

  it("states how many review passes it dropped, where they were", () => {
    const section = commentHistorySection([
      review("First pass."),
      review("Second pass."),
      review("Third pass."),
      comment("Ping.", { author: "user" }),
    ]);

    expect(section).toContain(
      "_[2 earlier review passes omitted — superseded by the most recent review below.]_",
    );
    // The notice sits where the dropped reviews were, before the survivor.
    expect(section.indexOf("omitted")).toBeLessThan(section.indexOf("Third pass."));
    // ...and only once, however many passes were dropped.
    expect(section.match(/omitted/g)).toHaveLength(1);
  });

  it("uses the singular for a single dropped pass", () => {
    const section = commentHistorySection([review("Old."), review("New.")]);
    expect(section).toContain("1 earlier review pass omitted");
  });

  it("treats every review_* agent type as a review", () => {
    const section = commentHistorySection([
      review("Security pass.", "review_security"),
      review("Feature pass.", "review_feature"),
    ]);

    expect(section).not.toContain("Security pass.");
    expect(section).toContain("Feature pass.");
  });

  it("keeps a comment whose agent type is unknown", () => {
    // A comment whose session was deleted has no agent type; dropping it on a
    // guess would lose user-visible history.
    const section = commentHistorySection([
      comment("Orphaned comment.", { agentType: null }),
      review("The review."),
    ]);

    expect(section).toContain("Orphaned comment.");
    expect(section).toContain("The review.");
  });

  it("collapses a long review history to a fraction of its size", () => {
    const passes = Array.from({ length: 5 }, (_, i) =>
      review(`Pass ${i}\n${"finding line\n".repeat(1000)}`),
    );
    const full = passes.map((c) => c.content).join("").length;
    const section = commentHistorySection(passes);

    expect(section.length).toBeLessThan(full / 4);
    expect(section).toContain("Pass 4");
  });
});
