import { withAgentResolutionErrors } from "@/lib/api/agent-resolution-response";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions, namedAgents } from "@/lib/db/schema";
import { eq, and, desc, isNotNull, isNull } from "drizzle-orm";
import { resolveAgent, resolveAgentByNamedId } from "@/lib/agent-config/agent-resolution";
import { isAgentProvider, type AgentType } from "@/lib/agent-config/constants";
import { isResumableProvider } from "@/lib/agent-sessions/resume-capability";
import type { ProviderType } from "@/lib/providers";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Any known provider resolves to itself. This must not be a short allowlist:
 * an unrecognised provider yields null, which drops the provider filter from
 * the query entirely and hands back other providers' sessions as resume
 * candidates.
 */
function normalizeProvider(value: string | null | undefined): ProviderType | null {
  return value && isAgentProvider(value) ? value : null;
}

export const GET = withAgentResolutionErrors(async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const { searchParams } = new URL(request.url);
  const epicId = searchParams.get("epicId");
  const userStoryId = searchParams.get("userStoryId");
  const agentType = searchParams.get("agentType");
  const requestedNamedAgentId = searchParams.get("namedAgentId");
  const requestedProvider = normalizeProvider(searchParams.get("provider"));

  let resolvedProvider: ProviderType | null = requestedProvider;
  let resolvedNamedAgentId: string | null | undefined =
    requestedNamedAgentId && requestedNamedAgentId.trim().length > 0
      ? requestedNamedAgentId.trim()
      : undefined;

  if (agentType) {
    const resolved = resolvedNamedAgentId
      ? resolveAgentByNamedId(agentType as AgentType, projectId, resolvedNamedAgentId)
      : resolveAgent(agentType as AgentType, projectId);
    resolvedProvider = resolved.provider as ProviderType;
    resolvedNamedAgentId = resolved.namedAgentId ?? null;
  } else if (resolvedNamedAgentId) {
    const namedAgent = db
      .select({ id: namedAgents.id })
      .from(namedAgents)
      .where(eq(namedAgents.id, resolvedNamedAgentId))
      .get();

    if (!namedAgent) {
      return NextResponse.json({ data: [] });
    }

    // Unfold the explicit choice even without a role filter. Reading the
    // composite sentinel directly would drop the provider/member filters.
    const resolved = resolveAgentByNamedId("build", projectId, namedAgent.id);
    resolvedProvider = resolved.provider;
    resolvedNamedAgentId = resolved.namedAgentId ?? null;
  }

  // A provider that cannot resume has nothing to offer. Listing its sessions
  // anyway produces a picker entry that dispatch silently ignores, starting a
  // fresh run instead of the resume the user asked for.
  if (resolvedProvider && !isResumableProvider(resolvedProvider)) {
    return NextResponse.json({ data: [] });
  }

  const conditions = [
    eq(agentSessions.projectId, projectId),
    eq(agentSessions.status, "completed"),
    isNotNull(agentSessions.cliSessionId),
  ];

  if (epicId) {
    conditions.push(eq(agentSessions.epicId, epicId));
  }

  if (userStoryId) {
    conditions.push(eq(agentSessions.userStoryId, userStoryId));
  }

  if (agentType) {
    conditions.push(eq(agentSessions.agentType, agentType));
  }

  if (resolvedProvider) {
    conditions.push(eq(agentSessions.provider, resolvedProvider));
    if (resolvedNamedAgentId) {
      conditions.push(eq(agentSessions.namedAgentId, resolvedNamedAgentId));
    } else if (resolvedNamedAgentId === null) {
      conditions.push(isNull(agentSessions.namedAgentId));
    }
  }

  const sessions = db
    .select({
      id: agentSessions.id,
      cliSessionId: agentSessions.cliSessionId,
      provider: agentSessions.provider,
      namedAgentId: agentSessions.namedAgentId,
      agentType: agentSessions.agentType,
      lastNonEmptyText: agentSessions.lastNonEmptyText,
      completedAt: agentSessions.completedAt,
    })
    .from(agentSessions)
    .where(and(...conditions))
    .orderBy(desc(agentSessions.completedAt))
    .limit(10)
    .all();

  return NextResponse.json({ data: sessions });
});
