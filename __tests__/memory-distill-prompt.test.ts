/**
 * Learned project memory — prompt assembly:
 *
 *   1. buildMemoryDistillPrompt: frames the current memory + just-finished
 *      session context and instructs a full-document merge-rewrite under the
 *      hard cap, output as raw markdown only.
 *   2. memorySection injection in agent builders: present when the project
 *      carries memory, byte-identically absent otherwise (on/off), and
 *      suppressed via explicit null (the distill flow relies on this so the
 *      doc it rewrites is not also injected as context).
 */
import { describe, it, expect } from "vitest";
import {
  buildMemoryDistillPrompt,
  buildBuildPrompt,
  buildTicketBuildPrompt,
  buildTechCheckPrompt,
  type PromptProject,
} from "@/lib/claude/prompt-builder";
import { PROJECT_MEMORY_HEADING } from "@/lib/claude/prompt-sections";
import {
  PROJECT_MEMORY_MAX_CHARS,
  PROJECT_MEMORY_MAX_TOKENS,
} from "@/lib/documents/memory-constants";

const project: PromptProject = { name: "Arij", spec: "The spec" };

describe("buildMemoryDistillPrompt", () => {
  it("includes the current memory and full session context", () => {
    const prompt = buildMemoryDistillPrompt(
      project,
      "- Existing convention: use nanoid",
      {
        ticketTitle: "Add login flow",
        agentType: "ticket_build",
        outcome: "answered",
        resultSummary: "Implemented login with zod validation.",
      },
      "System says hi"
    );

    expect(prompt).toContain("# System Instructions");
    expect(prompt).toContain("System says hi");
    expect(prompt).toContain("# Project: Arij");
    expect(prompt).toContain("## Current Project Memory");
    expect(prompt).toContain("- Existing convention: use nanoid");
    expect(prompt).toContain("## Just-Finished Session");
    expect(prompt).toContain("**Ticket:** Add login flow");
    expect(prompt).toContain("**Agent type:** ticket_build");
    expect(prompt).toContain("**Outcome:** answered");
    expect(prompt).toContain("### Session Result");
    expect(prompt).toContain("Implemented login with zod validation.");
  });

  it("instructs merge of durable conventions, no per-ticket trivia, under the cap", () => {
    const prompt = buildMemoryDistillPrompt(project, "memory", {});

    expect(prompt).toContain("## Task: Distill Project Memory");
    expect(prompt).toContain("Rewrite the ENTIRE memory document");
    expect(prompt).toContain("NEVER include per-ticket trivia");
    expect(prompt).toContain("MERGE, don't append");
    expect(prompt).toContain(
      `must stay under ${PROJECT_MEMORY_MAX_TOKENS} tokens`
    );
    expect(prompt).toContain(`about ${PROJECT_MEMORY_MAX_CHARS} characters`);
  });

  it("demands the raw document body as the only output", () => {
    const prompt = buildMemoryDistillPrompt(project, null, {});

    expect(prompt).toContain(
      "Your ENTIRE response must be ONLY the new memory document body"
    );
    expect(prompt).toContain("Do NOT wrap it in code fences");
  });

  it("handles empty memory and missing session metadata", () => {
    const prompt = buildMemoryDistillPrompt(project, null, {});

    expect(prompt).toContain("(The project memory is currently empty.)");
    expect(prompt).toContain("(No session metadata available.)");
    expect(prompt).not.toContain("### Session Result");
  });

  it("does not inject the standard memory section (the doc gets its own framing)", () => {
    const prompt = buildMemoryDistillPrompt(
      { ...project, memory: "should not leak via memorySection" },
      "current memory",
      {}
    );

    expect(prompt).not.toContain(`## ${PROJECT_MEMORY_HEADING}`);
  });
});

describe("memorySection injection in agent builders", () => {
  const memory = "- Durable rule: envelope every API response";

  it("injects the memory block when the project carries memory", () => {
    const buildPrompt = buildBuildPrompt(
      { ...project, memory },
      [],
      { title: "Epic" },
      []
    );
    const ticketPrompt = buildTicketBuildPrompt(
      { ...project, memory },
      [],
      { title: "Epic" },
      { title: "Story" },
      []
    );
    const techCheckPrompt = buildTechCheckPrompt({ ...project, memory });

    for (const prompt of [buildPrompt, ticketPrompt, techCheckPrompt]) {
      expect(prompt).toContain(`## ${PROJECT_MEMORY_HEADING}`);
      expect(prompt).toContain(memory);
    }
  });

  it("omits the block entirely when there is no memory (byte-identical off state)", () => {
    const withoutField = buildBuildPrompt(project, [], { title: "Epic" }, []);
    const withNull = buildBuildPrompt(
      { ...project, memory: null },
      [],
      { title: "Epic" },
      []
    );
    const withEmpty = buildBuildPrompt(
      { ...project, memory: "" },
      [],
      { title: "Epic" },
      []
    );

    expect(withoutField).not.toContain(PROJECT_MEMORY_HEADING);
    expect(withNull).toBe(withoutField);
    expect(withEmpty).toBe(withoutField);
  });
});
