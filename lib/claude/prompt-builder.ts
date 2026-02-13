/**
 * Prompt composition for all Claude Code interactions in Arij.
 *
 * Each builder assembles a structured markdown prompt from project data,
 * documents, epics/user stories, and the global system prompt configured
 * in the agent configuration.
 */

// ---------------------------------------------------------------------------
// Types — lightweight projections of the Drizzle schema rows
// ---------------------------------------------------------------------------

export interface PromptProject {
  name: string;
  description?: string | null;
  spec?: string | null;
}

export interface PromptDocument {
  name: string;
  contentMd: string;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PromptEpic {
  title: string;
  description?: string | null;
}

export interface PromptUserStory {
  title: string;
  description?: string | null;
  acceptanceCriteria?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function section(heading: string, content: string | null | undefined): string {
  if (!content || content.trim().length === 0) return "";
  return `## ${heading}\n\n${content.trim()}\n`;
}

function systemSection(systemPrompt: string | null | undefined): string {
  if (!systemPrompt || systemPrompt.trim().length === 0) return "";
  return `# System Instructions\n\n${systemPrompt.trim()}\n\n`;
}

function documentsSection(documents: PromptDocument[]): string {
  if (documents.length === 0) return "";

  const parts = documents.map(
    (doc) => `### ${doc.name}\n\n${doc.contentMd.trim()}`,
  );

  return `## Reference Documents\n\n${parts.join("\n\n---\n\n")}\n`;
}

function existingEpicsSection(existingEpics: PromptEpic[]): string {
  if (existingEpics.length === 0) return "";

  const list = existingEpics
    .map((epic) => `- ${epic.title}`)
    .join("\n");

  return `## Existing Epics\n\n${list}\n`;
}

function chatHistorySection(messages: PromptMessage[]): string {
  if (messages.length === 0) return "";

  const formatted = messages.map((msg) => {
    const prefix = msg.role === "user" ? "**User:**" : "**Assistant:**";
    return `${prefix}\n${msg.content.trim()}`;
  });

  return `## Conversation History\n\n${formatted.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// 1. Chat Brainstorm Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for the brainstorm chat panel.
 * Claude Code runs in plan mode to discuss ideas and refine the project.
 */
export function buildChatPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  messages: PromptMessage[],
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));

  parts.push(`# Project: ${project.name}\n`);

  parts.push(section("Project Description", project.description));
  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));
  parts.push(chatHistorySection(messages));

  parts.push(`## Instructions

You are helping brainstorm and refine this project. Answer the user's latest message considering the full project context above. Be specific, actionable, and reference the project's existing specification and documents when relevant.

If the user asks about architecture, features, or implementation details, provide concrete suggestions grounded in the project's context.
`);

  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 2. Spec Generation Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for generating or regenerating the project specification.
 * Claude Code runs in plan mode and is expected to return structured JSON
 * containing the spec, epics, and user stories.
 */
export function buildSpecGenerationPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  chatHistory: PromptMessage[],
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));

  parts.push(`# Project: ${project.name}\n`);

  parts.push(section("Project Description", project.description));
  parts.push(section("Current Specification", project.spec));
  parts.push(documentsSection(documents));
  parts.push(chatHistorySection(chatHistory));

  parts.push(`## Task: Generate Project Specification & Plan

Based on the project description, uploaded documents, and conversation history above, produce a comprehensive project specification with an implementation plan.

## Output Format (JSON)

Return a single JSON object with the following structure:

\`\`\`json
{
  "spec": "Full project specification in markdown...",
  "epics": [
    {
      "title": "Epic title",
      "description": "Detailed description of the epic",
      "priority": 0,
      "user_stories": [
        {
          "title": "As a [role], I want [feature] so that [benefit]",
          "description": "Detailed description",
          "acceptance_criteria": "- [ ] Criterion 1\\n- [ ] Criterion 2"
        }
      ]
    }
  ]
}
\`\`\`

## Rules

- The \`spec\` field should be a detailed markdown document covering: project overview, objectives, constraints, technical stack recommendations, architecture, and key decisions.
- Order epics by implementation priority (most foundational first).
- Priority values: 0 = low, 1 = medium, 2 = high, 3 = critical.
- Each epic should have 2-8 user stories with clear acceptance criteria.
- User stories should follow the "As a [role], I want [feature] so that [benefit]" format.
- Acceptance criteria should be a markdown checklist.
- Be specific and actionable -- avoid vague descriptions.
- If a current specification exists, refine and improve it rather than starting from scratch.
- Incorporate any relevant details from the reference documents and conversation history.

## CRITICAL OUTPUT RULES

Your final response MUST be ONLY the raw JSON object. No markdown, no explanation, no summary, no code fences. Just the JSON starting with \`{\` and ending with \`}\`. Do not wrap it in \`\`\`json code blocks. Do not add any text before or after the JSON. The very first character of your response must be \`{\` and the very last must be \`}\`.
`);

  return parts.filter(Boolean).join("\n");
}

export function buildSpecPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  chatHistory: PromptMessage[],
  systemPrompt?: string | null,
): string {
  return buildSpecGenerationPrompt(project, documents, chatHistory, systemPrompt);
}

// ---------------------------------------------------------------------------
// 3. Import Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for analyzing an existing project directory.
 * Claude Code runs in analyze mode within the target project's directory
 * and writes the structured JSON assessment to `arji.json` at the project root.
 */
export function buildImportPrompt(
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));

  parts.push(`# Task: Analyze Existing Project

Analyze the codebase in the current directory and produce a structured assessment.

## Analysis Steps

1. **Scan the codebase**: file structure, README, package.json / pyproject.toml / Cargo.toml, CLAUDE.md, docs, tests.
2. **Generate the spec**: produce a description of the project, detected stack, and architecture.
3. **Decompose into epics and user stories**: identify existing modules/features and translate them into epics with user stories.
4. **Assign statuses**: evaluate each epic/US based on the code found.

## Rules

- An epic is "done" if the code is functional AND has tests.
- An epic is "in_progress" if code exists but is incomplete, has TODOs, or lacks tests.
- An epic is "backlog" if mentioned in docs/README/issues but not yet implemented.
- Include a confidence score (0.0 to 1.0) for each status assessment.
- Be conservative: prefer "in_progress" over "done" when uncertain.
- The \`evidence\` field should reference specific files, directories, or patterns found.

## Output

Write your analysis as a JSON file at \`./arji.json\` in the project root (the current working directory). Use the Write tool to create this file.

The JSON must have the following structure:

{
  "project": {
    "name": "detected project name",
    "description": "what this project does",
    "stack": "detected technologies",
    "architecture": "high-level architecture description"
  },
  "epics": [
    {
      "title": "Epic name",
      "description": "What this epic covers",
      "status": "done | in_progress | backlog",
      "confidence": 0.0,
      "evidence": "why this status (files, tests, TODOs found)",
      "user_stories": [
        {
          "title": "US title",
          "description": "As a... I want... so that...",
          "acceptance_criteria": "- [ ] Criterion 1",
          "status": "done | in_progress | todo",
          "evidence": "files/tests that support this status"
        }
      ]
    }
  ]
}

IMPORTANT: The file must contain only valid JSON — no markdown, no code fences, no comments. Just the raw JSON object.
`);

  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 4. Epic Refinement Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for the epic refinement chat — a back-and-forth
 * conversation where Claude helps the user define a new epic before
 * generating user stories.
 */
export function buildEpicRefinementPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  messages: PromptMessage[],
  systemPrompt?: string | null,
  existingEpics: PromptEpic[] = [],
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));
  parts.push(`# Project: ${project.name}\n`);
  parts.push(section("Project Description", project.description));
  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));
  parts.push(existingEpicsSection(existingEpics));
  parts.push(chatHistorySection(messages));

  parts.push(`## Instructions

You are helping define a new epic for this project. Based on the conversation so far, help the user refine their idea into a well-scoped epic.

- If the description is vague or incomplete, ask 1-2 targeted clarifying questions.
- If the scope seems too large, suggest how to break it down.
- Guide the user toward a concrete epic title, epic description, user stories, and acceptance criteria.
- Use the existing epics list above to avoid overlap and suggest clear differentiation.
- Keep your responses concise (2-4 paragraphs max).
- Reference the project's existing specification and documents when relevant.
- Do NOT generate the final epic or user stories yet — just help refine the idea.
`);

  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 4b. Epic Finalization Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt that asks the AI to output the final structured epic
 * with user stories as JSON, based on the refinement conversation so far.
 */
export function buildEpicFinalizationPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  messages: PromptMessage[],
  systemPrompt?: string | null,
  existingEpics: PromptEpic[] = [],
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));
  parts.push(`# Project: ${project.name}\n`);
  parts.push(section("Project Description", project.description));
  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));
  parts.push(existingEpicsSection(existingEpics));
  parts.push(chatHistorySection(messages));

  parts.push(`## Instructions

Based on the conversation above, generate the final epic with user stories.

Return ONLY a JSON code block with the following structure — no extra text, no explanation, just the fenced JSON:

\`\`\`json
{
  "title": "Epic title",
  "description": "Detailed epic description including implementation plan",
  "userStories": [
    {
      "title": "As a [role], I want [feature] so that [benefit]",
      "description": "Detailed description of the user story",
      "acceptanceCriteria": "- [ ] Criterion 1\\n- [ ] Criterion 2"
    }
  ]
}
\`\`\`

Rules:
- The title should be concise and descriptive.
- The description should include a detailed implementation plan.
- Generate 2-8 user stories that fully cover the epic scope.
- User stories must follow the "As a [role], I want [feature] so that [benefit]" format.
- Acceptance criteria must be a markdown checklist.
- Be specific and actionable — avoid vague descriptions.
- Incorporate relevant details from the project spec and reference documents.
`);

  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 5. Epic Creation Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for generating a single epic with user stories from
 * the refinement conversation. Claude writes the result into arji.json.
 */
export function buildEpicCreationPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  messages: PromptMessage[],
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));
  parts.push(`# Project: ${project.name}\n`);
  parts.push(section("Project Description", project.description));
  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));
  parts.push(chatHistorySection(messages));

  parts.push(`## Task: Generate Epic with User Stories

Based on the conversation above, generate a single epic with user stories and add it to the project's \`arji.json\` file.

## Steps

1. Read the existing \`./arji.json\` file in the current directory.
2. Create a new epic object and append it to the \`epics\` array.
3. Write the updated \`arji.json\` using the Write tool.

## Epic Format

Each epic in the \`epics\` array has this structure:

\`\`\`json
{
  "id": "a_unique_12char_id",
  "title": "Epic title",
  "description": "Detailed description including the implementation plan",
  "priority": 1,
  "status": "backlog",
  "position": 0,
  "branchName": null,
  "user_stories": [
    {
      "id": "another_12char_id",
      "title": "As a [role], I want [feature] so that [benefit]",
      "description": "Detailed description",
      "acceptance_criteria": "- [ ] Criterion 1\\n- [ ] Criterion 2",
      "status": "todo",
      "position": 0
    }
  ]
}
\`\`\`

## Rules

- Generate a unique 12-character alphanumeric ID for the epic and each user story (e.g. "aB3xK9mR2pLq").
- Set the epic's \`position\` to be one higher than the highest existing position in the epics array (or 0 if empty).
- Include a detailed implementation plan in the epic's \`description\` field.
- Generate 2-8 user stories that cover the epic scope.
- User stories must follow the "As a [role], I want [feature] so that [benefit]" format.
- Acceptance criteria must be a markdown checklist.
- Priority values: 0 = low, 1 = medium, 2 = high, 3 = critical.
- Be specific and actionable — avoid vague descriptions.
- Incorporate relevant details from the project spec and reference documents.
- Do NOT modify or remove any existing epics in the array.
- Preserve the exact structure and content of the rest of the file.
`);

  return parts.filter(Boolean).join("\n");
}

/**
 * Builds a lightweight prompt for generating a 2-4 word conversation title.
 */
export function buildTitleGenerationPrompt(
  firstUserMessage: string,
  firstAssistantResponse: string,
): string {
  const trimmedResponse = firstAssistantResponse.slice(0, 500);
  return [
    "Generate a concise 2-4 word title for this conversation. Return ONLY the title text, nothing else.",
    "",
    `User: ${firstUserMessage}`,
    "",
    `Assistant: ${trimmedResponse}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 7. Build Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for implementing an epic with Claude Code in code mode.
 * The prompt includes the full project context, the target epic, and its
 * user stories with acceptance criteria.
 */
export interface TeamEpic {
  title: string;
  description?: string | null;
  worktreePath: string;
  userStories: PromptUserStory[];
}

/**
 * Builds the prompt for team-mode builds where Claude Code acts as a team
 * lead and delegates tickets to sub-agents via the Task tool.
 *
 * Each epic is listed with its worktree path so sub-agents know where to work.
 * Claude Code decides team composition and task allocation.
 */
export function buildTeamBuildPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  teamEpics: TeamEpic[],
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));
  parts.push(`# Project: ${project.name}\n`);
  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));

  // Epics section
  parts.push(`## Epics to Implement\n`);
  parts.push(
    `You have ${teamEpics.length} epics to implement. Each epic has its own git worktree.\n`,
  );

  for (let i = 0; i < teamEpics.length; i++) {
    const epic = teamEpics[i];
    parts.push(`### Epic ${i + 1}: ${epic.title}\n`);
    parts.push(`**Worktree path:** \`${epic.worktreePath}\`\n`);

    if (epic.description) {
      parts.push(`${epic.description.trim()}\n`);
    }

    if (epic.userStories.length > 0) {
      parts.push(`**User Stories:**\n`);
      const storyLines = epic.userStories.map((us) => {
        const lines: string[] = [];
        lines.push(`- [ ] **${us.title}**`);
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
    }
  }

  parts.push(`## Instructions — Team Lead Mode

You are the **team lead**. Your job is to coordinate the implementation of all ${teamEpics.length} epics listed above by delegating work to sub-agents.

### How to Delegate

Use the \`Task\` tool to spawn sub-agents for each epic (or group of related tickets). Each sub-agent should:

1. Work inside the epic's worktree path (specified above).
2. Implement the user stories and meet all acceptance criteria.
3. Commit changes with clear, descriptive commit messages using conventional commit format.
4. Write tests that verify the acceptance criteria.

### Team Composition

You decide how to organize the team:
- You may assign one sub-agent per epic, or split an epic across multiple agents if it has many independent user stories.
- You may run multiple sub-agents in parallel for independent work.
- Coordinate dependencies — if one epic depends on another, sequence them.

### Your Responsibilities

1. **Plan**: Analyze the epics and decide task allocation.
2. **Delegate**: Use the \`Task\` tool to dispatch sub-agents with clear, complete instructions. Include the worktree path and relevant context in each task prompt.
3. **Monitor**: Review sub-agent results as they complete.
4. **Report**: After all sub-agents finish, provide a summary of what was accomplished.

### Important Rules

- Do NOT implement code yourself — delegate ALL implementation to sub-agents via the Task tool.
- Each sub-agent must work in its designated worktree path.
- Pass the full project spec and relevant epic details to each sub-agent.
- If a sub-agent fails, analyze the error and retry or reassign.
`);

  return parts.filter(Boolean).join("\n");
}

export function buildBuildPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  epic: PromptEpic,
  userStories: PromptUserStory[],
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));

  parts.push(`# Project: ${project.name}\n`);

  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));

  // Epic section
  parts.push(`## Epic to Implement\n`);
  parts.push(`### ${epic.title}\n`);
  if (epic.description) {
    parts.push(`${epic.description.trim()}\n`);
  }

  // User stories
  if (userStories.length > 0) {
    parts.push(`### User Stories\n`);

    const storyLines = userStories.map((us) => {
      const lines: string[] = [];
      lines.push(`- [ ] **${us.title}**`);

      if (us.description) {
        lines.push(`  ${us.description.trim()}`);
      }

      if (us.acceptanceCriteria) {
        lines.push(`  **Acceptance criteria:**`);
        // Indent each line of the acceptance criteria
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
  }

  parts.push(`## Instructions

Implement this epic following the specification above. For each user story:

1. Create or modify the necessary files.
2. Write tests that verify the acceptance criteria.
3. Ensure all acceptance criteria are met before moving to the next story.

Commit your changes with clear, descriptive commit messages that reference the epic and user story titles. Use conventional commit format when possible.

Work through the user stories in order. If a story depends on another, implement the dependency first.
`);

  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 8. Ticket Build Prompt (Send-to-Dev)
// ---------------------------------------------------------------------------

export interface PromptComment {
  author: "user" | "agent";
  content: string;
  createdAt: string;
}

/**
 * Builds the prompt for implementing a single ticket (user story) with
 * Claude Code in code mode. Includes project context, epic context, the
 * ticket details, and the full comment history.
 */
export function buildTicketBuildPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  epic: PromptEpic,
  story: PromptUserStory,
  comments: PromptComment[],
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));
  parts.push(`# Project: ${project.name}\n`);
  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));

  // Epic context
  parts.push(`## Epic Context\n`);
  parts.push(`### ${epic.title}\n`);
  if (epic.description) {
    parts.push(`${epic.description.trim()}\n`);
  }

  // Ticket details
  parts.push(`## Ticket to Implement\n`);
  parts.push(`### ${story.title}\n`);
  if (story.description) {
    parts.push(`${story.description.trim()}\n`);
  }
  if (story.acceptanceCriteria) {
    parts.push(`**Acceptance Criteria:**\n`);
    parts.push(`${story.acceptanceCriteria.trim()}\n`);
  }

  // Comment history
  if (comments.length > 0) {
    parts.push(`## Comment History\n`);
    const formatted = comments.map((c) => {
      const prefix = c.author === "user" ? "**User:**" : "**Agent:**";
      return `${prefix}\n${c.content.trim()}`;
    });
    parts.push(formatted.join("\n\n") + "\n");
  }

  parts.push(`## Instructions

Implement this ticket following the specification and acceptance criteria above. Consider all comments in the history — they may contain clarifications, feedback, or specific instructions.

1. Create or modify the necessary files.
2. Ensure all acceptance criteria are met.
3. Commit your changes with a clear, descriptive commit message referencing the ticket title.
`);

  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 9. Review Prompt (Agent Review)
// ---------------------------------------------------------------------------

export type ReviewType = "security" | "code_review" | "compliance";

export interface CustomReviewAgentPrompt {
  name: string;
  systemPrompt: string;
}

const REVIEW_CHECKLISTS: Record<ReviewType, string> = {
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
};

/**
 * Builds the prompt for a review agent (plan mode). Each review type gets a
 * specialized checklist. The agent reads the code and posts findings as a
 * comment.
 */
export function buildReviewPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  epic: PromptEpic,
  story: PromptUserStory,
  reviewType: ReviewType | CustomReviewAgentPrompt,
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));
  parts.push(`# Project: ${project.name}\n`);
  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));

  // Epic context
  parts.push(`## Epic Context\n`);
  parts.push(`### ${epic.title}\n`);
  if (epic.description) {
    parts.push(`${epic.description.trim()}\n`);
  }

  // Ticket details
  parts.push(`## Ticket Under Review\n`);
  parts.push(`### ${story.title}\n`);
  if (story.description) {
    parts.push(`${story.description.trim()}\n`);
  }
  if (story.acceptanceCriteria) {
    parts.push(`**Acceptance Criteria:**\n`);
    parts.push(`${story.acceptanceCriteria.trim()}\n`);
  }

  const isCustomReview = typeof reviewType !== "string";

  if (isCustomReview) {
    parts.push(`## Custom Review Agent Instructions\n\n${reviewType.systemPrompt.trim()}\n`);
    parts.push(`\n## Instructions

You are performing a **${reviewType.name}** review on the code changes for the ticket described above.

1. Read the relevant source files in the current working directory.
2. Follow the custom review instructions above exactly.
3. Produce a structured markdown report with findings and recommendations.
4. If no issues are found, state "No issues found."
`);
  } else {
    // Built-in review checklist
    parts.push(REVIEW_CHECKLISTS[reviewType]);

    parts.push(`\n## Instructions

You are performing a **${reviewType.replace("_", " ")}** on the code changes for the ticket described above.

1. Read the relevant source files in the current working directory.
2. Evaluate the code against every item in the checklist above.
3. Produce a structured report with your findings.
4. If no issues are found for a category, state "No issues found."
5. End with a summary: total findings by severity, and an overall assessment (Approved / Approved with Minor Issues / Changes Requested).

Your response should be a well-formatted markdown report.
`);
  }

  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 10. Merge Conflict Resolution Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for an agent that resolves git merge conflicts.
 * The agent runs in code mode inside a worktree where `git merge` has
 * already been started, leaving conflicted files on disk.
 */
export function buildMergeResolutionPrompt(
  project: PromptProject,
  epic: PromptEpic,
  branchName: string,
  conflictOutput: string,
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));
  parts.push(`# Project: ${project.name}\n`);
  parts.push(section("Project Specification", project.spec));

  parts.push(`## Epic Context\n`);
  parts.push(`### ${epic.title}\n`);
  if (epic.description) {
    parts.push(`${epic.description.trim()}\n`);
  }

  parts.push(`## Merge Conflict Resolution\n`);
  parts.push(`Branch: \`${branchName}\`\n`);
  parts.push(`### Git merge output\n`);
  parts.push("```\n" + conflictOutput.trim() + "\n```\n");

  parts.push(`## Instructions

A \`git merge main\` was started in this worktree and resulted in conflicts. The conflicted files are on disk with standard conflict markers.

Your task:

1. List all conflicted files using \`git diff --name-only --diff-filter=U\`.
2. For each conflicted file, read it and resolve the conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) by preserving the intent of both sides. If in doubt, prefer the feature branch changes but ensure main's changes are not lost.
3. After resolving each file, run \`git add <file>\` to mark it resolved.
4. Once all conflicts are resolved, run \`git commit --no-edit\` to finalize the merge commit with the default message.
5. Verify with \`git status\` that the working tree is clean.

Do NOT abort the merge. Do NOT create a new branch. Work only in this worktree.
`);

  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 11. Epic Review Prompt
// ---------------------------------------------------------------------------

/**
 * Builds the prompt for an epic-level review agent (plan mode).
 * Scoped to the entire epic and all its user stories.
 */
export function buildEpicReviewPrompt(
  project: PromptProject,
  documents: PromptDocument[],
  epic: PromptEpic,
  userStories: PromptUserStory[],
  reviewType: ReviewType,
  systemPrompt?: string | null,
): string {
  const parts: string[] = [];

  parts.push(systemSection(systemPrompt));
  parts.push(`# Project: ${project.name}\n`);
  parts.push(section("Project Specification", project.spec));
  parts.push(documentsSection(documents));

  // Epic details
  parts.push(`## Epic Under Review\n`);
  parts.push(`### ${epic.title}\n`);
  if (epic.description) {
    parts.push(`${epic.description.trim()}\n`);
  }

  // All user stories in this epic
  if (userStories.length > 0) {
    parts.push(`### User Stories\n`);
    const storyLines = userStories.map((us) => {
      const lines: string[] = [];
      lines.push(`- **${us.title}**`);
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
  }

  // Review checklist
  parts.push(REVIEW_CHECKLISTS[reviewType]);

  parts.push(`\n## Instructions

You are performing a **${reviewType.replace("_", " ")}** on the entire epic described above, covering all user stories.

1. Read the relevant source files in the current working directory.
2. Evaluate the code against every item in the checklist above.
3. Produce a structured report with your findings.
4. If no issues are found for a category, state "No issues found."
5. End with a summary: total findings by severity, and an overall assessment (Approved / Approved with Minor Issues / Changes Requested).

Your response should be a well-formatted markdown report.
`);

  return parts.filter(Boolean).join("\n");
}
