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
import {
  REFINEMENT_ACTIONS,
  REFINEMENT_ACTION_IDS,
  type RefinementAction,
} from "@/lib/refinement/options";
import { REFINEMENT_AGENT_TYPE } from "@/lib/refinement/constants";
import { extraMcpToolPrefix } from "@/lib/claude/mcp-injection";

import type {
  PromptDocument,
  PromptEpic,
  PromptMessage,
  PromptProject,
  PromptUserStory,
  PromptComment,
  ReviewType,
} from "./prompt-builder";

export type PromptContextSectionKey =
  | "spec"
  | "memory"
  | "ticket"
  | "comments"
  | "findings"
  | "documents"
  | "system"
  | "other";

/** Receives the exact fragments a prompt builder appends, grouped by context. */
export type PromptSectionCollector = (
  key: PromptContextSectionKey,
  text: string,
) => void;
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

/**
 * Formats a conversation history block with role prefixes.
 *
 * Not fenced — a replayed conversation reads better inline, and fencing it
 * would change every existing chat prompt — but control markup is still
 * neutralised, exactly like `descriptionSection` and the comment history.
 * Message bodies are stored, user- and agent-writable text replayed into
 * later prompts, so they are the same class of channel as the spec.
 */
export function chatHistorySection(messages: PromptMessage[]): string {
  if (messages.length === 0) return "";
  const formatted = messages.map((msg) => {
    const prefix = msg.role === "user" ? "**User:**" : "**Assistant:**";
    return `${prefix}\n${neutralizeControlMarkup(msg.content.trim())}`;
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
 * Token-budgeted by construction: the content is hard-capped on write at
 * PROJECT_MEMORY_MAX_TOKENS estimated tokens (lib/documents/memory-constants.ts).
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
  refinementActions: readonly RefinementAction[] = REFINEMENT_ACTION_IDS,
): string {
  const naming = toolPrefix
    ? `through MCP tools named ${toolPrefix}*`
    : "through the arij MCP server's tools, mounted under their bare names";
  if (agentType === REFINEMENT_AGENT_TYPE) {
    const boardTools = REFINEMENT_ACTIONS
      .filter((action) => refinementActions.includes(action.id))
      .flatMap((action) => action.tools);
    return section("Arij tools",
      `You are connected to Arij ${naming}. This session is attached to the ` +
      "project board, not to a single ticket. Name the target with ticket_id " +
      "when a tool needs a ticket; there is no default ticket. " +
      "Use get_ticket to inspect a ticket, ask_question when blocked on the " +
      "user, report_friction for tooling problems, and attach_artifact to " +
      "preserve visual evidence. " +
      `Your selected board tools are: ${boardTools.join(", ") || "none"}. ` +
      "Use each tool's required fields and explain why you changed the board. " +
      "These actions apply to Backlog and To do only. " +
      (refinementActions.includes("readiness")
        ? "promote_ticket is your column-move channel; sending work back requires a question. "
        : "Column moves are disabled for this pass. ") +
      (refinementActions.includes("merge") || refinementActions.includes("discard")
        ? "Retired tickets are deleted permanently with no undo; tickets with agent history cannot be retired. "
        : "") +
      "Only the selected actions are permitted, regardless of additional instructions."
    );
  }
  const base =
    "You are connected to Arij, the orchestrator that launched this session, " +
    `${naming}. Use them for structured signals ` +
    "instead of prose conventions: get_ticket to re-read current ticket " +
    "state; post_comment for substantive progress/result notes; " +
    "create_bug to preserve an adjacent bug as a standalone, non-blocking " +
    "ticket in the current project; " +
    "update_ticket_status to move the ticket (transitions are validated — " +
    "To Merge is reached by a passing review verdict and Done by the merge " +
    "itself, never by this tool); ask_question when you are blocked " +
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
        "verdict decides the ticket's next column — a passing verdict moves " +
        "it to To Merge (ready for the user to merge), 'changes_requested' " +
        "sends it back to In Progress. Each finding you file (file+line " +
        "anchored) becomes a review comment on the ticket, and an " +
        "'approved' verdict filed alongside a [critical] or [major] finding " +
        "still counts as changes requested. When your prompt " +
        "lists prior findings with [RC:id] tokens, report each one you " +
        "verified in prior_findings ('fixed' resolves it in Arij; a finding " +
        "you do not mention stays open). Call it once, at the end, with " +
        "your real verdict. Also end your final message with the required " +
        "'**Overall Verdict: …**' line: it is the fallback Arij reads only " +
        "when no submit_findings verdict was recorded."
      : "";

  const gradingExtra =
    agentType === "grading"
      ? " Grade every acceptance criterion and submit the complete structured " +
        "report with submit_grading before ending the session; prose is not " +
        "a substitute for the tool call."
      : "";

  return section(
    "Arij tools",
    base + buildExtra + reviewExtra + gradingExtra,
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
 * SECURITY NOTE: `usage_hint` is stored, user-editable text, so it is passed
 * through `neutralizeControlMarkup` like every other stored string this file
 * renders.
 *
 * What CANNOT be neutralised here is the tool DESCRIPTIONS these servers return
 * at runtime: they land in the agent's context without ever passing through
 * Arij, and are the same untrusted-input surface as `projects.spec`. Declaring
 * a server is what grants it that reach; the trade-off is documented in
 * docs/architecture/mcp-provider-matrix.md so it is a decision rather than a
 * surprise.
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
    // `usage_hint` is DB-stored free text rendered straight into the model's
    // instruction stream — the same untrusted-input class as the project
    // description above, which this file already neutralises. Neutralise BEFORE
    // measuring, so the budget counts the string that is actually emitted.
    const hint = neutralizeControlMarkup(server.usageHint?.trim() ?? "");
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
export function userStoriesSection(
  userStories: PromptUserStory[],
  options: { heading?: string; checkmark?: boolean } = {},
): string {
  if (userStories.length === 0) return "";

  const { heading = "User Stories", checkmark = true } = options;
  const parts: string[] = [];

  parts.push(`### ${heading}\n`);

  const storyLines = userStories.map((us) => {
    const lines: string[] = [];
    const prefix = checkmark ? "- [ ] " : "- ";
    lines.push(`${prefix}**${us.title}**`);

    if (us.description) {
      lines.push(`  ${us.description.trim()}`);
    }

    if (us.acceptanceCriteria) {
      lines.push(`  **Acceptance criteria:**`);
      const criteria = us.acceptanceCriteria
        .trim()
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      lines.push(criteria);
    }

    return lines.join("\n");
  });

  parts.push(storyLines.join("\n\n") + "\n");
  return parts.join("");
}

export const PROMPT_COMMENT_MAX_CHARS = 4_000;
const PROMPT_COMMENT_HEAD_CHARS = 3_200;
const PROMPT_COMMENT_TAIL_CHARS = 600;
export const PROMPT_AGENT_COMMENTS_KEPT = 5;

function isReviewComment(comment: PromptComment): boolean {
  return (
    typeof comment.agentType === "string" &&
    comment.agentType.startsWith("review_")
  );
}

function capPromptCommentBody(content: string): string {
  if (content.length <= PROMPT_COMMENT_MAX_CHARS) return content;
  const omitted =
    content.length - PROMPT_COMMENT_HEAD_CHARS - PROMPT_COMMENT_TAIL_CHARS;
  // Agent-facing: this marker is part of the prompt, so its numeral is pinned
  // to "en-US" and never follows the interface locale (lib/i18n/format.ts).
  return (
    `${content.slice(0, PROMPT_COMMENT_HEAD_CHARS)}\n\n` +
    `_[… ${omitted.toLocaleString("en-US")} characters of this comment omitted …]_\n\n` +
    `${content.slice(-PROMPT_COMMENT_TAIL_CHARS)}`
  );
}

export function commentHistorySection(comments?: PromptComment[]): string {
  if (!comments || comments.length === 0) return "";

  const lastReviewIndex = comments.reduce(
    (last, comment, index) => (isReviewComment(comment) ? index : last),
    -1,
  );
  const elidedReviews = comments.filter(
    (comment, index) => isReviewComment(comment) && index !== lastReviewIndex,
  ).length;

  const agentIndexes = comments
    .map((comment, index) => ({ comment, index }))
    .filter(
      ({ comment }) => comment.author !== "user" && !isReviewComment(comment),
    )
    .map(({ index }) => index);
  const keptAgentIndexes = new Set(
    agentIndexes.slice(-PROMPT_AGENT_COMMENTS_KEPT),
  );
  const elidedAgents = agentIndexes.length - keptAgentIndexes.size;

  const rendered: string[] = [];
  let reviewNoticeEmitted = false;
  let agentNoticeEmitted = false;
  comments.forEach((comment, index) => {
    if (isReviewComment(comment) && index !== lastReviewIndex) {
      if (!reviewNoticeEmitted) {
        reviewNoticeEmitted = true;
        rendered.push(
          `_[${elidedReviews} earlier review pass${elidedReviews > 1 ? "es" : ""} omitted — superseded by the most recent review below.]_`,
        );
      }
      return;
    }
    if (
      comment.author !== "user" &&
      !isReviewComment(comment) &&
      !keptAgentIndexes.has(index)
    ) {
      if (!agentNoticeEmitted) {
        agentNoticeEmitted = true;
        rendered.push(
          `_[${elidedAgents} earlier agent update${elidedAgents > 1 ? "s" : ""} omitted — the most recent updates below carry the current state.]_`,
        );
      }
      return;
    }
    const prefix = comment.author === "user" ? "**User:**" : "**Agent:**";
    rendered.push(
      `${prefix}\n${neutralizeControlMarkup(capPromptCommentBody(comment.content.trim()))}`,
    );
  });

  return `## Comment History\n\n${rendered.join("\n\n")}\n`;
}

export const BUG_RED_GREEN_SECTION = `## Bug-Fix Rule — mandatory red → green regression test

This ticket is a **bug fix**. The pipeline runs a mechanical regression check on your branch, so follow this exact order:

1. **Write the failing test first.** Add (or modify) a test that reproduces the reported bug and run it — it MUST fail against the unfixed code.
2. **Then apply the fix.** Make the minimal change that makes the same test pass.
3. **Commit the test file(s) together with the fix.** The check inspects the files added/modified on the branch and selects them with the project's configured test-file patterns — follow this repository's existing test layout and naming. A diff with no test file fails (\`no_test_in_diff\`), a test that already passes without the fix fails (\`test_passes_on_base\`), and a test still failing on the branch fails (\`test_fails_on_branch\`). Any of these sends the ticket back to a fix cycle.`;

export const VISUAL_PROOF_SECTION = `## Optional visual proof

If this project has a UI, a browser is available, and the \`attach_artifact\` tool is available, run the application, exercise the functionality you implemented, capture 1 to 3 screenshots, and attach each screenshot with \`attach_artifact\` using a clear caption.

Visual proof is best-effort and is never a completion requirement. If the application or browser cannot be run, the tool is unavailable, or no useful screenshot can be produced, complete the session normally. Missing visual proof must never make the build fail.`;

export const REVIEW_CHECKLISTS: Record<ReviewType, string> = {
  security: `## Security Audit Checklist

Review the code changes for this ticket against the following security criteria:

1. **OWASP Top 10**: Check for injection flaws (SQL, XSS, command injection), broken authentication, sensitive data exposure, XML external entities, broken access control, security misconfiguration, insecure deserialization, using components with known vulnerabilities, insufficient logging.
2. **Input Validation**: All user inputs are validated and sanitized. No raw user input reaches SQL queries, shell commands, or HTML rendering.
3. **Authentication & Authorization**: Auth checks are present where required. No privilege escalation paths. Session handling is secure.
4. **Secrets Exposure**: No hardcoded API keys, passwords, tokens, or credentials in code. Secrets loaded from environment variables or secure config.
5. **Data Protection**: Sensitive data encrypted at rest and in transit. No PII in logs. Proper error messages that don't leak internal details.
6. **Dependencies**: No known vulnerable dependencies introduced. Lockfile is consistent.

For each finding, specify:
- **Severity**: Critical / High / Medium / Low / Info
- **Location**: File path and line number
- **Description**: What the issue is
- **Recommendation**: How to fix it`,

  code_review: `## Code Review Checklist

Review the code changes for this ticket against the following quality criteria:

1. **Readability**: Code is clear, well-structured, and easy to understand. Variable/function names are descriptive. Complex logic is commented.
2. **DRY Principle**: No significant code duplication. Shared logic is properly abstracted.
3. **Error Handling**: All error paths are handled gracefully. No unhandled promise rejections. Proper error messages for users.
4. **Performance**: No obvious performance issues (N+1 queries, unnecessary re-renders, missing indexes, large payloads). Efficient algorithms for the data sizes involved.
5. **Naming Conventions**: Consistent naming (camelCase for JS/TS, proper component naming for React). File names match conventions.
6. **Type Safety**: Full TypeScript types, no \`any\` types. Proper interfaces for data structures.
7. **Testing**: Adequate test coverage. Edge cases considered. Tests are maintainable and descriptive.
8. **API Design**: Consistent REST conventions. Proper HTTP status codes. Clear request/response shapes.

For each finding, specify:
- **Severity**: Critical / Major / Minor / Suggestion
- **Location**: File path and line number
- **Description**: What the issue is
- **Recommendation**: How to improve it`,

  compliance: `## Compliance & Accessibility Checklist

Review the code changes for this ticket against the following standards:

1. **WCAG Accessibility (Level AA)**:
   - Semantic HTML elements used correctly (headings, landmarks, lists)
   - All interactive elements are keyboard-accessible
   - Proper ARIA labels and roles where needed
   - Color contrast meets 4.5:1 ratio for text
   - Focus indicators visible
   - Form inputs have associated labels
   - Images have alt text
   - Screen reader compatibility
2. **Internationalization (i18n) Readiness**:
   - No hardcoded user-facing strings (or flagged for future extraction)
   - Date/number formatting considers locale
   - RTL layout support not broken
   - Text containers can accommodate longer translations
3. **License Compliance**:
   - New dependencies use compatible licenses (MIT, Apache 2.0, BSD)
   - No GPL-licensed packages in a proprietary codebase (unless intended)
   - Attribution requirements met

For each finding, specify:
- **Severity**: Critical / Major / Minor / Suggestion
- **Location**: File path and line number
- **Description**: What the issue is
- **Recommendation**: How to fix it`,

  feature_review: `## Feature Completeness Checklist

Verify that the implementation fully satisfies the ticket's acceptance criteria and delivers a complete, working feature. Use ALL available tools — browser, shell commands, test runners, etc. — to validate each point.

1. **Acceptance Criteria Verification**:
   - Go through each acceptance criterion one by one
   - For UI features: launch the app and use the browser to verify the feature works as described
   - For API features: make actual HTTP requests to verify endpoints behave correctly
   - For CLI/backend features: run the relevant commands and verify output
   - Document PASS/FAIL for each criterion with evidence (screenshots, command output, etc.)

2. **Functional Completeness**:
   - All user-facing flows described in the ticket are implemented end-to-end
   - Edge cases mentioned in the description or acceptance criteria are handled
   - No placeholder or TODO code left for critical paths
   - Error states are handled and display meaningful feedback to the user

3. **Integration**:
   - The feature integrates correctly with existing functionality (no regressions in adjacent features)
   - Data flows correctly between frontend and backend
   - Navigation and routing work as expected

4. **Tests**:
   - Tests exist that cover the acceptance criteria
   - Run the tests covering the code this branch touches and verify they pass — prefer the project's targeted script (e.g. \`npm run test:changed\`) or your runner's changed-files filter over the full suite; other agent sessions share this machine and the merge gate re-runs the regression check
   - Report any failing tests with details

For each criterion, specify:
- **Status**: PASS / FAIL / PARTIAL
- **Evidence**: What you did to verify (command run, URL visited, screenshot taken)
- **Details**: Description of what works or what's missing`,
};

export const BUG_REVIEW_CHECKLIST = `## Bug Fix Verification Checklist

Verify that the bug fix correctly addresses the reported issue without introducing regressions. Use ALL available tools — browser, shell commands, test runners, etc. — to validate each point.

1. **Bug Fix Verification**:
   - Reproduce the original bug scenario (or confirm the conditions that triggered it)
   - Verify the fix resolves the reported issue
   - Check that the root cause is addressed, not just the symptom
   - Document PASS/FAIL with evidence (screenshots, command output, etc.)

2. **Regression Check**:
   - Verify that adjacent functionality is not broken by the fix
   - Test related features and flows that might be affected
   - Check edge cases around the fix area

3. **Code Quality**:
   - The fix is minimal and focused on the bug
   - No unrelated changes are included
   - Error handling is appropriate for the fix area

4. **Tests**:
   - Tests exist that cover the bug scenario
   - Run the tests covering the code this branch touches and verify they pass — prefer the project's targeted script (e.g. \`npm run test:changed\`) or your runner's changed-files filter over the full suite; other agent sessions share this machine and the merge gate re-runs the regression check
   - Report any failing tests with details

For each criterion, specify:
- **Status**: PASS / FAIL / PARTIAL
- **Evidence**: What you did to verify (command run, URL visited, screenshot taken)
- **Details**: Description of what works or what's missing`;

export const REVIEW_BOUNDARY_SECTION = `## Review Boundary — No Code Modifications

This session deliberately runs with full tool access — shell, browser, test
runners, and MCP tools — so nothing blocks your investigation. In exchange,
the no-modification rule is yours to uphold, not the harness's:

- Do not edit, create, or delete repository files. Do not stage, commit,
  amend, revert, or push. Leave branches and the git state exactly as found.
- Running the app, executing tests, and building are all allowed, including
  when they write caches or generated artifacts; leave any such incidental
  output uncommitted and set it aside in your report.
- When you spot a concrete fix, describe it in a finding — never apply it
  yourself.`;
