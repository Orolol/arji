/**
 * Shared prompt section helpers.
 *
 * Each function produces a self-contained markdown block (or empty string when
 * the input is empty/null). Compose them inside the builder functions in
 * `prompt-builder.ts`.
 */

import type {
  PromptDocument,
  PromptEpic,
  PromptMessage,
  PromptProject,
} from "./prompt-builder";

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** Returns `## heading\n\ncontent\n` or `""` when content is empty/null. */
export function section(heading: string, content: string | null | undefined): string {
  if (!content || content.trim().length === 0) return "";
  return `## ${heading}\n\n${content.trim()}\n`;
}

/** Wraps a system prompt as `# System Instructions` block. */
export function systemSection(systemPrompt: string | null | undefined): string {
  if (!systemPrompt || systemPrompt.trim().length === 0) return "";
  return `# System Instructions\n\n${systemPrompt.trim()}\n\n`;
}

/** Formats reference documents separated by `---`. */
export function documentsSection(documents: PromptDocument[]): string {
  if (documents.length === 0) return "";
  const parts = documents.map(
    (doc) => `### ${doc.name}\n\n${doc.contentMd.trim()}`,
  );
  return `## Reference Documents\n\n${parts.join("\n\n---\n\n")}\n`;
}

/** Lists existing epic titles for deduplication context. */
export function existingEpicsSection(existingEpics: PromptEpic[]): string {
  if (existingEpics.length === 0) return "";
  const list = existingEpics.map((epic) => `- ${epic.title}`).join("\n");
  return `## Existing Epics\n\n${list}\n`;
}

/** Formats a conversation history block with role prefixes. */
export function chatHistorySection(messages: PromptMessage[]): string {
  if (messages.length === 0) return "";
  const formatted = messages.map((msg) => {
    const prefix = msg.role === "user" ? "**User:**" : "**Assistant:**";
    return `${prefix}\n${msg.content.trim()}`;
  });
  return `## Conversation History\n\n${formatted.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Semantic helpers — named after the prompt *concept* they represent
// ---------------------------------------------------------------------------

/** Returns the `# Project: {name}` heading. */
export function projectHeader(name: string): string {
  return `# Project: ${name}\n`;
}

/** Alias for `section("Project Description", ...)`. */
export function descriptionSection(description: string | null | undefined): string {
  return section("Project Description", description);
}

/** Alias for `section("Project Specification", ...)`. */
export function specSection(spec: string | null | undefined): string {
  return section("Project Specification", spec);
}

/** Heading used for the learned project memory block in every agent prompt. */
export const PROJECT_MEMORY_HEADING =
  "Project memory (conventions learned from previous sessions)";

/**
 * Learned project memory block. Empty string when the project has no
 * memory document (or it is empty) — the section is simply omitted, so
 * prompts for projects without memory are byte-identical to before.
 * Token-cheap by construction: the content is hard-capped on write
 * (PROJECT_MEMORY_MAX_CHARS in lib/documents/memory-constants.ts).
 */
export function memorySection(memory: string | null | undefined): string {
  return section(PROJECT_MEMORY_HEADING, memory);
}

// ---------------------------------------------------------------------------
// Composite helpers
// ---------------------------------------------------------------------------

/**
 * Standard project context block used by most builders:
 * `# Project: {name}` + Description + Specification + Project Memory +
 * Reference Documents.
 *
 * The memory block renders from `project.memory` — builders resolve it from
 * the memory document before composing (see `withProjectMemory` in
 * prompt-builder.ts), keeping this module pure.
 *
 * Returns the parts joined as a single string (empty sections omitted).
 */
export function projectContextSections(
  project: PromptProject,
  documents: PromptDocument[],
): string {
  const parts = [
    projectHeader(project.name),
    descriptionSection(project.description),
    specSection(project.spec),
    memorySection(project.memory),
    documentsSection(documents),
  ];
  return parts.filter(Boolean).join("\n");
}

/**
 * Instructions for the Arij MCP tool channel (the mcp__arij tools, in the
 * spawning provider's spelling).
 *
 * Deliberately called by NO builder function in prompt-builder.ts: the
 * section is appended centrally by processManager.start() — and only when
 * MCP injection is active for that spawn — so prompts stay byte-identical
 * when the toggle is off, for unsupported providers, and for direct
 * spawnClaude call sites (generate-spec, import) that never inject. CLI
 * chat turns (lib/chat/cli-tool-channel.ts) get no prompt section either:
 * the chat toolset's tool descriptions carry their own usage guidance, so
 * chat prompts stay byte-identical with and without the channel.
 *
 * Review agents (agentType `review_*`) get an extra sentence pointing at
 * submit_findings while keeping the prose "**Overall Verdict: …**" line the
 * review route still parses (the verdict stays prose-driven in v1).
 *
 * `toolPrefix` is the spawning provider's tool-name spelling
 * (arijMcpToolPrefix in mcp-injection.ts): omp names the tools
 * `mcp__arij_*`, one underscore short of claude/codex — the default keeps
 * claude/codex prompts byte-identical.
 */
export function arijToolsSection(
  agentType: string | null,
  toolPrefix = "mcp__arij__",
): string {
  const base =
    "You are connected to Arij, the orchestrator that launched this session, " +
    `through MCP tools named ${toolPrefix}*. Use them for structured signals ` +
    "instead of prose conventions: get_ticket to re-read current ticket " +
    "state; post_comment for substantive progress/result notes; " +
    "update_ticket_status to move the ticket (transitions are validated — " +
    "review→done requires human approval); ask_question when you are blocked " +
    "on the user — it reliably holds the ticket and marks the session as " +
    "awaiting a reply, so prefer it over ending with a question in text.";

  const reviewExtra =
    agentType && agentType.startsWith("review_")
      ? " File review findings with submit_findings (file+line anchored; " +
        "open findings block approval), and still end your final message " +
        "with the required '**Overall Verdict: …**' line."
      : "";

  return section("Arij tools", base + reviewExtra);
}
