/**
 * Autonomous pipeline — forensic diagnostic prompt.
 *
 * When a pipeline stage exhausts its retry ladder, the runner dispatches a
 * cheap 'forensic' agent whose only job is to explain WHY the dead session
 * failed. This module composes its prompt; it is pure (no db, no fs) so the
 * whole content matrix is unit-testable, and it is only ever called through
 * `runForensic` (lib/pipeline/forensic.ts).
 *
 * The evidence handed to the agent is whatever the dead session left behind:
 * its provider/model, the persisted error, the tail of its raw + output
 * chunk streams, and its last non-empty text. Any of it may be missing (a
 * session that died before producing a single chunk is the common case), so
 * every block degrades to an explicit "(none)" marker rather than
 * disappearing silently — the diagnosis "the agent produced no output at
 * all" is itself a useful finding.
 */

import {
  projectHeader,
  memorySection,
  systemSection,
  descriptionSection,
} from "@/lib/claude/prompt-sections";
import type { PromptProject } from "@/lib/claude/prompt-builder";

/** Max words the diagnostic may use — mirrored in the prompt instructions. */
export const FORENSIC_MAX_WORDS = 400;

export interface ForensicPromptInput {
  project: PromptProject;
  ticketTitle: string | null;
  /** Pipeline stage that died ('build' | 'grading' | 'review' | 'fix'). */
  stage: string;
  /** Attempts burned on that stage before giving up. */
  attempts: number;
  provider: string | null;
  model: string | null;
  /** Error persisted on the dead session row. */
  error: string | null;
  /** Tail of the dead session's 'raw' chunk stream. */
  rawTail: string | null;
  /** Tail of the dead session's 'output' chunk stream. */
  outputTail: string | null;
  /** Dead session's last non-empty textual output. */
  lastText: string | null;
  systemPrompt?: string | null;
}

const NONE = "(none)";

function evidenceBlock(heading: string, body: string | null): string {
  const trimmed = body?.trim();
  if (!trimmed) {
    return `### ${heading}\n\n${NONE}\n`;
  }
  return `### ${heading}\n\n\`\`\`\n${trimmed}\n\`\`\`\n`;
}

/**
 * Composes the forensic prompt. Pure — all lookups (session row, chunk
 * tails, ticket title, memory) happen in `runForensic` before calling in.
 */
export function buildForensicPrompt(input: ForensicPromptInput): string {
  const parts: string[] = [];

  parts.push(systemSection(input.systemPrompt));
  parts.push(projectHeader(input.project.name));
  parts.push(descriptionSection(input.project.description));
  parts.push(memorySection(input.project.memory));

  parts.push(`## Failed Agent Session\n`);
  const facts: string[] = [
    `- **Ticket:** ${input.ticketTitle?.trim() || "(unknown ticket)"}`,
    `- **Pipeline stage:** ${input.stage}`,
    `- **Attempts before giving up:** ${input.attempts}`,
    `- **Provider:** ${input.provider || "(unknown)"}`,
    `- **Model:** ${input.model || "(provider default)"}`,
  ];
  parts.push(facts.join("\n") + "\n");

  parts.push(`## Evidence\n`);
  parts.push(evidenceBlock("Recorded error", input.error));
  parts.push(evidenceBlock("Raw stream (tail)", input.rawTail));
  parts.push(evidenceBlock("Output stream (tail)", input.outputTail));
  parts.push(evidenceBlock("Last text produced", input.lastText));

  parts.push(`## Task: Diagnose the Failure

The autonomous pipeline gave up on this ticket after the \`${input.stage}\` stage failed ${input.attempts} time(s). Read the evidence above and explain what went wrong so a human can decide what to do next.

### Rules

- DIAGNOSE ONLY. Do not edit files, do not run the build, do not fix anything, do not commit. Reading the repository for context is fine.
- Base every claim on the evidence above; quote the exact line(s) you rely on. If the evidence is empty or inconclusive, say so plainly instead of inventing a cause.
- Do NOT ask the user a question — this run has no one to answer it. Deliver the diagnosis as-is.
- HARD LIMIT: ${FORENSIC_MAX_WORDS} words.

### Output Format

Respond with exactly these three markdown sections and nothing else:

**Probable root cause** — one short paragraph.

**Evidence** — 1 to 3 bullets, each quoting the log/error fragment that supports the cause.

**Recommended next action** — one bullet, concrete and actionable: a configuration retry (different provider/model), a prompt or ticket-scope change, or a specific human intervention.
`);

  return parts.filter(Boolean).join("\n");
}
