/**
 * Learned project memory — dreaming prompt assembly (buildDreamingPrompt):
 *
 * The dream rewrites the entire memory document from a cross-session digest.
 * Like the distill prompt, the hard cap must be spelled out to the model that
 * writes the memory — in the unit Arij enforces (estimated tokens,
 * lib/tokens/estimator.ts) plus the character equivalent the writer can aim at.
 */
import { describe, it, expect } from "vitest";
import {
  buildDreamingPrompt,
  type DreamingDigestContext,
  type PromptProject,
} from "@/lib/claude/prompt-builder";
import {
  PROJECT_MEMORY_MAX_CHARS,
  PROJECT_MEMORY_MAX_TOKENS,
} from "@/lib/documents/memory-constants";

const project: PromptProject = { name: "Arij", spec: "The spec" };

const context: DreamingDigestContext = {
  digest: "### Session sess-1\n- Fixed the clone ownership marker check.",
  sessionCount: 1,
  sinceIso: "2026-01-01T00:00:00.000Z",
};

describe("buildDreamingPrompt", () => {
  it("states the hard cap in tokens for the model writing the memory", () => {
    const prompt = buildDreamingPrompt(project, null, context);

    expect(prompt).toContain("## Task: Dream the Project Memory");
    expect(prompt).toContain(
      `must stay under ${PROJECT_MEMORY_MAX_TOKENS} tokens`
    );
    expect(prompt).toContain(`about ${PROJECT_MEMORY_MAX_CHARS} characters`);
  });
});
