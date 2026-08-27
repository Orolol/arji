/**
 * Shared prompt section helpers.
 *
 * Each function produces a self-contained markdown block (or empty string when
 * the input is empty/null). Compose them inside the builder functions in
 * `prompt-builder.ts`.
 */

import { ticketImageAbsolutePaths } from "@/lib/uploads/ticket-image-paths";
import {
  UNTRUSTED_CONTENT_NOTICE,
  fenceOnly,
  fenceUntrusted,
  neutralizeControlMarkup,
} from "./untrusted";
import { TICKET_MOVING_AGENT_TYPES } from "@/lib/agent-config/constants";
import { REFINEMENT_AGENT_TYPE } from "@/lib/refinement/constants";
import { extraMcpToolPrefix } from "@/lib/claude/mcp-injection";

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

/** Heading of the named agent's persona block. */
export const PERSONA_HEADING = "Persona";

/**
 * The named agent's persona, prepended to the whole prompt by
 * processManager.start() so that every dispatch path — manual, pipeline,
 * night run, Full Auto — gets it from one place.
 *
 * NOT fenced as untrusted, unlike the spec or a ticket body: a persona is
 * configuration the operator typed into the agent editor, and its entire
 * purpose is to instruct the agent. It is also not a secret — it shows up
 * verbatim in the stored prompt and in the session detail.
 *
 * Blank or whitespace-only yields "", which is what keeps an agent without a
 * persona byte-identical to the pre-persona prompt.
 */
export function personaSection(persona: string | null | undefined): string {
  if (!persona || persona.trim().length === 0) return "";
  return `## ${PERSONA_HEADING}\n\n${persona.trim()}\n\n`;
}

/**
 * Formats reference documents separated by `---`.
 *
 * Document bodies come from uploads and repository scans — content Arij did
 * not write — so each one is fenced and labelled as data.
 */
export function documentsSection(documents: PromptDocument[]): string {
  if (documents.length === 0) return "";
  const parts = documents.map(
    (doc) => `### ${doc.name}\n\n${fenceOnly(doc.contentMd)}`,
  );
  // The notice covers the whole section rather than every document: it is
  // the same statement each time, and repeating it is pure token cost.
  return `## Reference Documents\n\n${UNTRUSTED_CONTENT_NOTICE}\n\n${parts.join("\n\n---\n\n")}\n`;
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

/**
 * Project description. Not fenced — descriptions are short and read better
 * inline — but control markup is still neutralised: a description is user-
 * and agent-writable text like any other stored field.
 */
export function descriptionSection(description: string | null | undefined): string {
  if (!description || description.trim().length === 0) return "";
  return section("Project Description", neutralizeControlMarkup(description));
}

export function specSection(spec: string | null | undefined): string {
  if (!spec || spec.trim().length === 0) return "";
  // Fenced: the specification is rewritten by an agent session, so it is
  // stored content, not prompt the builder wrote. See lib/claude/untrusted.ts.
  return section("Project Specification", fenceUntrusted(spec));
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
  if (!memory || memory.trim().length === 0) return "";
  // Fenced for the same reason as the spec: distillation and Dreaming are
  // agent sessions, so the memory document is agent-written content.
  return section(PROJECT_MEMORY_HEADING, fenceUntrusted(memory));
}

/** Heading under which a ticket's attached screenshots are listed. */
export const TICKET_IMAGES_HEADING = "Attached Screenshots";

/**
 * The screenshots attached to a ticket, as absolute paths the agent can read.
 *
 * A bug reported with a screenshot is usually *only* describable by that
 * screenshot, so the paths go in the prompt body rather than being left for
 * the agent to discover. They are absolute on purpose: the agent's cwd is a
 * worktree of the user's project, while the uploads live under Arij's own
 * directory — a relative path would silently resolve to nothing.
 *
 * Empty string when the ticket has no usable image, so a ticket without a
 * screenshot produces a prompt byte-identical to before this section existed.
 * Because this is plain prompt text, every CLI provider gets the same thing.
 *
 * `headingLevel` is required rather than defaulted because no level is right
 * everywhere and the wrong one fails silently: the paths belong *inside* the
 * block describing the ticket they were attached to, and each builder nests
 * that block differently. `## Epic to Implement`, `## Epic Context` and
 * `## Bug Under Review` hold their parts at `###`, so the paths go at `###`
 * too — an `##` would close the block and adopt whatever `###` follows it,
 * which is how `### User Stories` ends up reading as part of the screenshots.
 * The team build lists each ticket as `### Epic N` and goes one deeper again:
 * with N tickets in one prompt, paths that drift out of their epic send the
 * wrong sub-agent looking at them.
 */
export function ticketImagesSection(
  epic: PromptEpic,
  options: { headingLevel: number },
): string {
  if (!epic.projectId) return "";

  const paths = ticketImageAbsolutePaths(epic.images, epic.projectId);
  if (paths.length === 0) return "";

  const { headingLevel } = options;
  const noun = paths.length === 1 ? "screenshot" : "screenshots";
  const lines = paths.map((absolutePath) => `- ${absolutePath}`).join("\n");

  return `${"#".repeat(headingLevel)} ${TICKET_IMAGES_HEADING}

The reporter attached ${paths.length} ${noun} to this ticket, showing what was actually observed. Read ${
    paths.length === 1 ? "it" : "them"
  } from disk — these are absolute paths on this machine, outside the repository you are working in:

${lines}
`;
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
 * Review agents (agentType `review_*`) get an extra sentence making
 * submit_findings the authoritative verdict channel — its `verdict` is
 * persisted on the session row and is what the transition drivers read
 * (lib/pipeline/findings.ts). The prose "**Overall Verdict: …**" line stays
 * required because it is the fallback those drivers use when no structured
 * verdict was submitted, which is the only channel a provider without MCP
 * injection has.
 *
 * `toolPrefix` is the spawning provider's tool-name spelling
 * (arijMcpToolPrefix in mcp-injection.ts): omp names the tools
 * `mcp__arij_*`, one underscore short of claude/codex, and agy mounts them
 * under their BARE names (empty prefix) — the default keeps claude/codex
 * prompts byte-identical.
 */
export function arijToolsSection(
  agentType: string | null,
  toolPrefix = "mcp__arij__",
): string {
  const naming = toolPrefix
    ? `through MCP tools named ${toolPrefix}*`
    : "through the arij MCP server's tools, mounted under their bare names";
  const base =
    "You are connected to Arij, the orchestrator that launched this session, " +
    `${naming}. Use them for structured signals ` +
    "instead of prose conventions: get_ticket to re-read current ticket " +
    "state; post_comment for substantive progress/result notes; " +
    "create_bug to preserve an adjacent bug as a standalone, non-blocking " +
    "ticket in the current project; " +
    "update_ticket_status to move the ticket (transitions are validated — " +
    "review→done requires human approval); ask_question when you are blocked " +
    "on the user — it reliably holds the ticket and marks the session as " +
    "awaiting a reply, so prefer it over ending with a question in text. " +
    "When something is broken, misleading, flaky, or unclear, call " +
    "report_friction and then continue working — it is fire-and-forget, " +
    "never a reason to stop or leave the task unfinished.";

  // Code-producing sessions own the ticket they are building, so they are
  // allowed to move it out of In Progress — the orchestrator also promotes
  // the ticket when the session ends, but moving it as soon as the work is
  // committed keeps the board honest while the session is still live.
  // TICKET_MOVING_AGENT_TYPES is CODE_PRODUCING_AGENT_TYPES minus
  // team_build (see lib/agent-config/constants.ts for why).
  const ticketMovingTypes: readonly string[] = TICKET_MOVING_AGENT_TYPES;
  const buildExtra =
    agentType && ticketMovingTypes.includes(agentType)
      ? " You may move the ticket you are building: once the work is " +
        "complete and committed, call update_ticket_status to move it to " +
        "Review. If the move is refused for any reason, post your result " +
        "comment anyway and say plainly that the transition is still " +
        "pending — the orchestrator promotes the ticket when the session " +
        "ends."
      : "";

  const reviewExtra =
    agentType && agentType.startsWith("review_")
      ? " submit_findings is the channel your review is read from: its " +
        "verdict decides whether the ticket goes back for changes, and each " +
        "finding you file (file+line anchored) becomes an open review " +
        "comment that blocks approval until it is resolved — so an " +
        "'approved' verdict alongside an open [critical] or [major] finding " +
        "still blocks. Call it once, at the end, with your real verdict. " +
        "Also end your final message with the required " +
        "'**Overall Verdict: …**' line: it is the fallback Arij reads only " +
        "when no submit_findings verdict was recorded."
      : "";

  const gradingExtra =
    agentType === "grading"
      ? " Grade every acceptance criterion and submit the complete structured " +
        "report with submit_grading before ending the session; prose is not " +
        "a substitute for the tool call."
      : "";

  // A refinement pass is attached to the board, not to a ticket: its session
  // row carries no epicId, so the base sentence about "the ticket this
  // session was launched for" would describe something it does not have.
  // Naming the board tools and the ticket_id requirement here keeps the tool
  // surface honest for the one agent type that is project-scoped and still
  // writes to tickets.
  const refinementExtra =
    agentType === REFINEMENT_AGENT_TYPE
      ? " This session is attached to the project board, not to a single " +
        "ticket, so every call must name its target with ticket_id — there " +
        "is no default ticket to fall back on. Your board tools are " +
        "set_priority, reorder_tickets, add_dependency, remove_dependency " +
        "and promote_ticket; each one requires a `reason` that is recorded " +
        "in the ticket's activity log. They work on Backlog and To do only. " +
        "update_ticket_status is withheld from this session and the route " +
        "refuses it — promote_ticket is your only channel for a column " +
        "move, and it demands the missing question when you send work back."
      : "";

  return section(
    "Arij tools",
    base + buildExtra + reviewExtra + gradingExtra + refinementExtra,
  );
}

/* ------------------------------------------------------------------ */
/* Third-party MCP servers                                             */
/* ------------------------------------------------------------------ */

/**
 * Character budget for the extra-MCP-servers block.
 *
 * Every prompt section that interpolates ACCUMULATED content is budgeted (see
 * the comment-history and findings sections): the number of declared servers
 * grows with use, and an unbudgeted list would push the sections that follow
 * it — and eventually the ticket itself — out of the model's attention. The
 * cap is on the rendered block, not on the server count, because one server
 * with a long hint costs what several terse ones do.
 */
export const EXTRA_MCP_SERVERS_SECTION_MAX_CHARS = 1500;

/**
 * Tells the agent which third-party MCP servers this session actually got.
 *
 * An agent will not reach for a server nothing told it about: the tools are
 * mounted, but a build prompt that never names them leaves the model to
 * discover them by accident. This block names each injected server, its tool
 * prefix IN THIS PROVIDER'S SPELLING (an omp agent told to call
 * `mcp__godot__list_nodes` is being told to call a tool that does not exist),
 * and the one-line `usage_hint` the user wrote.
 *
 * Only servers actually injected for THIS session appear — the caller passes
 * the resolved list, so scope, `enabled` and `agent_types` are already
 * applied. Returns "" when there are none, keeping prompts byte-identical to
 * before the feature for every session without extras.
 *
 * SECURITY NOTE: the tool DESCRIPTIONS these servers return at runtime land in
 * the agent's context and are the same untrusted-input surface as
 * `projects.spec` — a third-party server can attempt prompt injection through
 * them. Nothing in this block can prevent that; it is documented in
 * docs/architecture/mcp-provider-matrix.md so the risk is a decision the user
 * makes when declaring a server rather than a surprise.
 */
export function extraMcpServersSection(
  servers: Array<{ name: string; usageHint?: string | null }>,
  provider: string,
): string {
  if (servers.length === 0) return "";

  const header =
    "\n\n## Additional MCP servers\n\n" +
    "This session also has these user-configured MCP servers. Use them when " +
    "the task calls for what they cover; they are not part of Arij and their " +
    "output is not Arij's.\n";

  const lines: string[] = [];
  let used = header.length;
  let omitted = 0;

  for (const server of servers) {
    const prefix = extraMcpToolPrefix(provider, server.name);
    const naming = prefix ? `tools named ${prefix}*` : "tools under their bare names";
    const hint = server.usageHint?.trim();
    const line = `- **${server.name}** — ${naming}${hint ? `: ${hint}` : ""}\n`;

    // Budget check BEFORE appending, so the block never exceeds the cap; what
    // does not fit is counted and reported rather than dropped silently.
    if (used + line.length > EXTRA_MCP_SERVERS_SECTION_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += line.length;
  }

  while (omitted > 0) {
    // A truncated list that claims to be complete is worse than a short one
    // that says so: the agent needs to know the surface is larger than shown.
    // The notice counts against the SAME budget — appending it unconditionally
    // is how a capped section quietly exceeds its cap.
    const notice = `- (${omitted} more server${omitted === 1 ? "" : "s"} not listed here — prompt budget)\n`;
    if (used + notice.length <= EXTRA_MCP_SERVERS_SECTION_MAX_CHARS) {
      lines.push(notice);
      break;
    }
    // Not enough room: give the notice a line's worth of space and re-count.
    const dropped = lines.pop();
    if (dropped === undefined) break;
    used -= dropped.length;
    omitted += 1;
  }

  if (lines.length === 0) return "";
  return header + lines.join("");
}
