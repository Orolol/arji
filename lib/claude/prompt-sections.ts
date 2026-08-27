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

import type {
  PromptDocument,
  PromptEpic,
  PromptMessage,
  PromptProject,
  PromptUserStory,
  PromptComment,
  ReviewType,
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
    comment.author !== "user" &&
    typeof comment.agentType === "string" &&
    comment.agentType.startsWith("review_")
  );
}

function capPromptCommentBody(content: string): string {
  if (content.length <= PROMPT_COMMENT_MAX_CHARS) return content;
  const omitted =
    content.length - PROMPT_COMMENT_HEAD_CHARS - PROMPT_COMMENT_TAIL_CHARS;
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

Focus on the user flow described in this ticket. Capturing visual proof is non-blocking: proceed with review if UI testing is not feasible.`;

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
   - Run the test suite and verify tests pass
   - Report any failing tests with details

For each criterion, specify:
- **Status**: PASS / FAIL / PARTIAL
- **Evidence**: What you did to verify (command run, URL visited, screenshot taken)
- **Details**: Description of what works or what's missing`,
};

export const BUG_REVIEW_CHECKLIST = `## Bug Fix Verification Checklist

Verify that the bug fix correctly addresses the reported issue without introducing regressions. Use ALL available tools — browser, shell commands, test runners, etc. — to validate each point.

1. **Bug Fix Verification**:
   - Verify the fix directly addresses the root cause reported in the ticket
   - Actively test the bug scenario using the browser, shell commands, or test runners
   - Confirm the error or unexpected behavior no longer occurs
   - Document PASS/FAIL for the bug fix with concrete evidence (command output, screenshots)

2. **Regression Check**:
   - Verify adjacent features and related workflows still function correctly
   - Check that no new error states or broken flows were introduced
   - Run existing test suites to confirm no regressions

3. **Code Quality**:
   - Minimal, focused change that addresses the bug without unnecessary refactoring
   - Proper error handling and edge cases considered
   - No temporary debug code or commented-out blocks left behind

4. **Test Coverage**:
   - A regression test exists that reproduces the bug and verifies the fix
   - Run the test and confirm it passes

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
