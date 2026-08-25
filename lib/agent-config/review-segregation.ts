import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentSessions, settings } from "@/lib/db/schema";
import {
  PROVIDER_OPTIONS,
  isAgentProvider,
  type AgentProvider,
} from "./constants";

import { REVIEW_PROVIDER_SEGREGATION_SETTING_KEY } from "./review-segregation-constants";

/**
 * Global settings key for the "Reviewer/grader must differ from builder" toggle.
 * Stored in the key/value settings table as the string 'true' / 'false'
 * (JSON-encoded by the settings PATCH route). Default: disabled.
 */
export { REVIEW_PROVIDER_SEGREGATION_SETTING_KEY };

/** Reads the global evaluator-provider-segregation toggle (default false). */
export function isReviewProviderSegregationEnabled(): boolean {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, REVIEW_PROVIDER_SEGREGATION_SETTING_KEY))
    .get();

  if (!row) return false;

  let parsed: unknown = row.value;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    // raw (non-JSON) string value — use as-is
  }
  return parsed === true || parsed === "true";
}

export interface ReviewSegregationTarget {
  projectId: string;
  epicId?: string;
  storyId?: string;
}

/** agentType values written by the build dispatch routes. */
const BUILD_AGENT_TYPES = ["build", "ticket_build"];

/**
 * Finds the provider of the latest terminal successful build session
 * (agentType 'build' or 'ticket_build', status 'completed') for the given
 * target. Story targets match on userStoryId; epic targets on epicId.
 * Returns null when the target has no successful build yet.
 */
export function findLastSuccessfulBuildProvider(
  target: ReviewSegregationTarget
): AgentProvider | null {
  if (!target.storyId && !target.epicId) return null;

  const targetFilter = target.storyId
    ? eq(agentSessions.userStoryId, target.storyId)
    : eq(agentSessions.epicId, target.epicId!);

  const row = db
    .select({ provider: agentSessions.provider })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, target.projectId),
        eq(agentSessions.status, "completed"),
        inArray(agentSessions.agentType, BUILD_AGENT_TYPES),
        targetFilter
      )
    )
    .orderBy(desc(agentSessions.createdAt))
    .limit(1)
    .get();

  if (!row?.provider || !isAgentProvider(row.provider)) return null;
  return row.provider;
}

/**
 * Picks a deterministic alternative to `builderProvider`: the first provider
 * in stable PROVIDER_OPTIONS order that differs from the builder and whose
 * CLI is available. Returns null when no alternative CLI is installed.
 *
 * `lib/providers` is imported lazily so pure resolution code paths (and
 * their tests) never instantiate the provider classes.
 */
export async function pickAlternativeReviewProvider(
  builderProvider: AgentProvider
): Promise<AgentProvider | null> {
  const { getProvider } = await import("@/lib/providers");

  for (const provider of PROVIDER_OPTIONS) {
    if (provider === builderProvider) continue;
    try {
      if (await getProvider(provider).isAvailable()) {
        return provider;
      }
    } catch {
      // treat availability-check failures as unavailable
    }
  }
  return null;
}
