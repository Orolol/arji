import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentSessions, namedAgents } from "@/lib/db/schema";
import { eq, and, desc, isNotNull, isNull } from "drizzle-orm";
import { resolveAgent, resolveAgentByNamedId } from "@/lib/agent-config/providers";
import type { AgentType } from "@/lib/agent-config/constants";
import type { ProviderType } from "@/lib/providers";

type Params = { params: Promise<{ projectId: string }> };

function normalizeProvider(value: string | null | undefined): ProviderType | null {
  if (value === "claude-code" || value === "gemini-cli" || value === "codex") {
    return value;
  }
  return null;
}

export async function GET(request: NextRequest, { params }: Params) {
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
      .select({ id: namedAgents.id, provider: namedAgents.provider })
      .from(namedAgents)
      .where(eq(namedAgents.id, resolvedNamedAgentId))
      .get();

    if (!namedAgent) {
      return NextResponse.json({ data: [] });
    }

    resolvedProvider = normalizeProvider(namedAgent.provider);
    resolvedNamedAgentId = namedAgent.id;
  }

  // Codex `exec` does not support resume; do not surface resumable sessions for it.
  if (resolvedProvider === "codex") {
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
      claudeSessionId: agentSessions.claudeSessionId,
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
}
