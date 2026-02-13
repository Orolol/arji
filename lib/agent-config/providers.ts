import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentProviderDefaults } from "@/lib/db/schema";
import { AGENT_TYPES, type AgentProvider, type AgentType } from "./constants";

export type ProviderSource = "builtin" | "global" | "project";

export interface ResolvedAgentProvider {
  agentType: AgentType;
  provider: AgentProvider;
  source: ProviderSource;
  scope: string;
}

const FALLBACK_PROVIDER: AgentProvider = "claude-code";

function normalizeProvider(value: string | null | undefined): AgentProvider {
  if (value === "codex") return "codex";
  if (value === "gemini-cli") return "gemini-cli";
  return "claude-code";
}

export async function resolveAgentProvider(
  agentType: AgentType,
  projectId?: string
): Promise<AgentProvider> {
  if (projectId) {
    const projectDefault = db
      .select({ provider: agentProviderDefaults.provider })
      .from(agentProviderDefaults)
      .where(
        and(
          eq(agentProviderDefaults.agentType, agentType),
          eq(agentProviderDefaults.scope, projectId)
        )
      )
      .get();
    if (projectDefault?.provider) {
      return normalizeProvider(projectDefault.provider);
    }
  }

  const globalDefault = db
    .select({ provider: agentProviderDefaults.provider })
    .from(agentProviderDefaults)
    .where(
      and(
        eq(agentProviderDefaults.agentType, agentType),
        eq(agentProviderDefaults.scope, "global")
      )
    )
    .get();
  if (globalDefault?.provider) {
    return normalizeProvider(globalDefault.provider);
  }

  return FALLBACK_PROVIDER;
}

function mapProviderRowsByType(
  rows: Array<{ agentType: string; provider: string; scope: string }>
): Map<string, { provider: AgentProvider; scope: string }> {
  const map = new Map<string, { provider: AgentProvider; scope: string }>();
  for (const row of rows) {
    map.set(row.agentType, {
      provider: normalizeProvider(row.provider),
      scope: row.scope,
    });
  }
  return map;
}

export async function listGlobalAgentProviders(): Promise<ResolvedAgentProvider[]> {
  const rows = db
    .select({
      agentType: agentProviderDefaults.agentType,
      provider: agentProviderDefaults.provider,
      scope: agentProviderDefaults.scope,
    })
    .from(agentProviderDefaults)
    .where(eq(agentProviderDefaults.scope, "global"))
    .all();

  const providersByType = mapProviderRowsByType(rows);

  return AGENT_TYPES.map((agentType) => {
    const row = providersByType.get(agentType);
    if (row) {
      return {
        agentType,
        provider: row.provider,
        source: "global" as const,
        scope: "global",
      };
    }

    return {
      agentType,
      provider: FALLBACK_PROVIDER,
      source: "builtin" as const,
      scope: "global",
    };
  });
}

export async function listMergedProjectAgentProviders(
  projectId: string
): Promise<ResolvedAgentProvider[]> {
  const globalRows = db
    .select({
      agentType: agentProviderDefaults.agentType,
      provider: agentProviderDefaults.provider,
      scope: agentProviderDefaults.scope,
    })
    .from(agentProviderDefaults)
    .where(eq(agentProviderDefaults.scope, "global"))
    .all();

  const projectRows = db
    .select({
      agentType: agentProviderDefaults.agentType,
      provider: agentProviderDefaults.provider,
      scope: agentProviderDefaults.scope,
    })
    .from(agentProviderDefaults)
    .where(eq(agentProviderDefaults.scope, projectId))
    .all();

  const globalByType = mapProviderRowsByType(globalRows);
  const projectByType = mapProviderRowsByType(projectRows);

  return AGENT_TYPES.map((agentType) => {
    const projectRow = projectByType.get(agentType);
    if (projectRow) {
      return {
        agentType,
        provider: projectRow.provider,
        source: "project" as const,
        scope: projectId,
      };
    }

    const globalRow = globalByType.get(agentType);
    if (globalRow) {
      return {
        agentType,
        provider: globalRow.provider,
        source: "global" as const,
        scope: "global",
      };
    }

    return {
      agentType,
      provider: FALLBACK_PROVIDER,
      source: "builtin" as const,
      scope: "global",
    };
  });
}
