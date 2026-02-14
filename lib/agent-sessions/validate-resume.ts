import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions } from "@/lib/db/schema";

interface ValidateResumeInput {
  resumeSessionId: string | undefined;
  epicId: string;
  userStoryId?: string;
}

interface ValidateResumeResult {
  cliSessionId: string;
}

/**
 * Validates that a resume session belongs to the same scope (epic/story).
 * Returns the cliSessionId if valid, null otherwise.
 */
export function validateResumeSession(
  input: ValidateResumeInput,
): ValidateResumeResult | null {
  const { resumeSessionId, epicId, userStoryId } = input;

  if (!resumeSessionId) return null;

  const prevSession = db
    .select({
      cliSessionId: agentSessions.cliSessionId,
      claudeSessionId: agentSessions.claudeSessionId,
      epicId: agentSessions.epicId,
      userStoryId: agentSessions.userStoryId,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, resumeSessionId))
    .get();

  if (!prevSession) return null;

  const previousCliSessionId =
    prevSession.cliSessionId ?? prevSession.claudeSessionId ?? null;

  if (!previousCliSessionId) return null;

  // Epic scope must always match
  if (prevSession.epicId !== epicId) return null;

  // If story-scoped, story must match too
  if (userStoryId && prevSession.userStoryId !== userStoryId) return null;

  return { cliSessionId: previousCliSessionId };
}
