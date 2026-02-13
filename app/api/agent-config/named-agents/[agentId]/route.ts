import { NextRequest, NextResponse } from "next/server";
import {
  getNamedAgent,
  updateNamedAgent,
  deleteNamedAgent,
} from "@/lib/agent-config/named-agents";
import { isAgentProvider } from "@/lib/agent-config/constants";

type Params = { params: Promise<{ agentId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const agent = await getNamedAgent(agentId);
  if (!agent) {
    return NextResponse.json({ error: "Named agent not found" }, { status: 404 });
  }
  return NextResponse.json({ data: agent });
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { agentId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const updates: Record<string, unknown> = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return NextResponse.json({ error: "name must be a non-empty string" }, { status: 400 });
      }
      updates.name = body.name;
    }

    if (body.provider !== undefined) {
      if (!isAgentProvider(body.provider)) {
        return NextResponse.json(
          { error: "provider must be 'claude-code', 'codex', or 'gemini-cli'" },
          { status: 400 },
        );
      }
      updates.provider = body.provider;
    }

    if (body.model !== undefined) {
      if (typeof body.model !== "string" || !body.model.trim()) {
        return NextResponse.json({ error: "model must be a non-empty string" }, { status: 400 });
      }
      updates.model = body.model;
    }

    const result = await updateNamedAgent(agentId, updates as Parameters<typeof updateNamedAgent>[1]);
    if (result.error) {
      const status = result.error.includes("not found") ? 404 : result.error.includes("already exists") ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ data: result.data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update named agent";
    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message.includes("already exists")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const deleted = await deleteNamedAgent(agentId);
  if (!deleted) {
    return NextResponse.json({ error: "Named agent not found" }, { status: 404 });
  }
  return NextResponse.json({ data: { success: true } });
}
