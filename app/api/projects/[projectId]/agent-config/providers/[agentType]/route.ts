import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentProviderDefaults, namedAgents, projects } from "@/lib/db/schema";
import { createId } from "@/lib/utils/nanoid";
import {
  isAgentProvider,
  isAgentType,
} from "@/lib/agent-config/constants";

type Params = { params: Promise<{ projectId: string; agentType: string }> };

async function validateProject(projectId: string) {
  return db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { projectId, agentType } = await params;
  if (!isAgentType(agentType)) {
    return NextResponse.json({ error: `Unknown agent type: ${agentType}` }, { status: 400 });
  }

  const project = await validateProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const providerInput = typeof body.provider === "string" ? body.provider : "";
  const namedAgentIdInput =
    typeof body.namedAgentId === "string" ? body.namedAgentId.trim() : "";

  let provider = providerInput;
  let namedAgentId: string | null = null;

  if (namedAgentIdInput) {
    const namedAgent = db
      .select({ id: namedAgents.id, provider: namedAgents.provider })
      .from(namedAgents)
      .where(eq(namedAgents.id, namedAgentIdInput))
      .get();

    if (!namedAgent) {
      return NextResponse.json({ error: "namedAgentId not found" }, { status: 400 });
    }

    provider = namedAgent.provider;
    namedAgentId = namedAgent.id;
  } else if (!isAgentProvider(provider)) {
    return NextResponse.json(
      { error: "provider must be 'claude-code', 'codex', or 'gemini-cli'" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const existing = db
    .select({ id: agentProviderDefaults.id })
    .from(agentProviderDefaults)
    .where(
      and(
        eq(agentProviderDefaults.agentType, agentType),
        eq(agentProviderDefaults.scope, projectId)
      )
    )
    .get();

  if (existing) {
    db.update(agentProviderDefaults)
      .set({ provider, namedAgentId, updatedAt: now })
      .where(eq(agentProviderDefaults.id, existing.id))
      .run();
  } else {
    db.insert(agentProviderDefaults)
      .values({
        id: createId(),
        agentType,
        provider,
        namedAgentId,
        scope: projectId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const updated = db
    .select()
    .from(agentProviderDefaults)
    .where(
      and(
        eq(agentProviderDefaults.agentType, agentType),
        eq(agentProviderDefaults.scope, projectId)
      )
    )
    .get();

  return NextResponse.json({ data: updated });
}
