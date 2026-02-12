/**
 * Resolves agent-specific custom prompts from the database.
 *
 * Resolution order: project override → global custom → null (use built-in).
 * The resolved prompt is injected into the prompt builder's globalPrompt
 * parameter, combined with the settings-level global prompt.
 */

import { db } from "@/lib/db";
import {
  agentPrompts,
  customReviewAgents,
  agentProviderDefaults,
  settings,
} from "@/lib/db/schema";
import { and, eq, or } from "drizzle-orm";
import type { AgentType } from "@/lib/types/agent-config";
import type { ProviderType } from "@/lib/providers/types";

/**
 * Resolves the custom system prompt for an agent type.
 * Returns null if no custom prompt is configured (use built-in default).
 */
export function resolveAgentPrompt(
  agentType: AgentType,
  projectId?: string
): string | null {
  if (projectId) {
    const projectRow = db
      .select()
      .from(agentPrompts)
      .where(
        and(
          eq(agentPrompts.agentType, agentType),
          eq(agentPrompts.scope, projectId)
        )
      )
      .get();
    if (projectRow) return projectRow.systemPrompt;
  }

  const globalRow = db
    .select()
    .from(agentPrompts)
    .where(
      and(
        eq(agentPrompts.agentType, agentType),
        eq(agentPrompts.scope, "global")
      )
    )
    .get();

  return globalRow?.systemPrompt ?? null;
}

/**
 * Gets the settings-level global prompt (from the settings table).
 */
export function getGlobalPrompt(): string {
  const row = db
    .select()
    .from(settings)
    .where(eq(settings.key, "global_prompt"))
    .get();
  if (!row) return "";
  try {
    return JSON.parse(row.value) || "";
  } catch {
    return "";
  }
}

/**
 * Combines the agent-specific custom prompt with the settings-level global
 * prompt. This is what gets passed to prompt builder functions.
 *
 * If an agent has a custom prompt configured, it is prepended before the
 * global prompt. If no custom prompt exists, only the global prompt is used.
 */
export function resolveFullPrompt(
  agentType: AgentType,
  projectId?: string
): string {
  const agentCustom = resolveAgentPrompt(agentType, projectId);
  const globalPrompt = getGlobalPrompt();

  const parts: string[] = [];
  if (agentCustom) parts.push(agentCustom);
  if (globalPrompt) parts.push(globalPrompt);

  return parts.join("\n\n");
}

/**
 * Resolves the default provider for an agent type.
 * Resolution: project override → global → 'claude-code'.
 */
export function resolveProvider(
  agentType: AgentType,
  projectId?: string
): ProviderType {
  if (projectId) {
    const projectRow = db
      .select()
      .from(agentProviderDefaults)
      .where(
        and(
          eq(agentProviderDefaults.agentType, agentType),
          eq(agentProviderDefaults.scope, projectId)
        )
      )
      .get();
    if (projectRow) return projectRow.provider as ProviderType;
  }

  const globalRow = db
    .select()
    .from(agentProviderDefaults)
    .where(
      and(
        eq(agentProviderDefaults.agentType, agentType),
        eq(agentProviderDefaults.scope, "global")
      )
    )
    .get();

  return (globalRow?.provider as ProviderType) ?? "claude-code";
}

/**
 * Gets all enabled custom review agents for a given scope.
 * Returns both global and project-scoped agents (if projectId is provided).
 */
export function getCustomReviewAgents(projectId?: string) {
  const conditions = projectId
    ? or(
        eq(customReviewAgents.scope, "global"),
        eq(customReviewAgents.scope, projectId)
      )
    : eq(customReviewAgents.scope, "global");

  return db
    .select()
    .from(customReviewAgents)
    .where(conditions)
    .all()
    .filter((a) => a.isEnabled === 1);
}
