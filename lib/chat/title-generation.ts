import { resolveAgent } from "@/lib/agent-config/agent-resolution";
import { resolveAgentPrompt } from "@/lib/agent-config/prompts";
import { buildTitleGenerationPrompt } from "@/lib/claude/prompt-builder";
import { getProvider } from "@/lib/providers";
import { createId } from "@/lib/utils/nanoid";

/**
 * Generate the short label used after a conversation's first exchange.
 *
 * The task has its own assignment key so a project can route this cheap,
 * mechanical work to a lightweight named agent. With no assignment the
 * resolver preserves the historical Claude Haiku default.
 */
export async function generateConversationTitle(input: {
  projectId: string;
  userContent: string;
  assistantContent: string;
}): Promise<string | null> {
  const resolvedAgent = resolveAgent("title_generation", input.projectId);
  const systemPrompt = await resolveAgentPrompt(
    "title_generation",
    input.projectId
  );
  const prompt = buildTitleGenerationPrompt(
    input.userContent,
    input.assistantContent,
    systemPrompt
  );
  const session = getProvider(resolvedAgent.provider).spawn({
    sessionId: `title-${createId()}`,
    prompt,
    cwd: process.cwd(),
    mode: "plan",
    model: resolvedAgent.model,
    logIdentifier: `title-${input.projectId}`,
  });
  const result = await session.promise;

  if (!result.success || !result.result) return null;

  let title = result.result.trim();
  try {
    const parsed = JSON.parse(title) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "result" in parsed &&
      typeof parsed.result === "string"
    ) {
      title = parsed.result;
    } else if (typeof parsed === "string") {
      title = parsed;
    }
  } catch {
    // The prompt asks for plain text; use it directly when it is not JSON.
  }

  title = title.replace(/^["']|["']$/g, "").trim();
  return title && title.length <= 60 ? title : null;
}
