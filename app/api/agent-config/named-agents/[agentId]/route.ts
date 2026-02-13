import { NextRequest, NextResponse } from "next/server";
import {
  deleteNamedAgent,
  updateNamedAgent,
} from "@/lib/agent-config/named-agents";

type Params = { params: Promise<{ agentId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await updateNamedAgent(agentId, {
    name: body.name,
    provider: body.provider,
    model: body.model,
  });

  if (!result.data && result.error === "Named agent not found") {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }

  if (!result.data && result.error) {
    const status = result.error.includes("exists") ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ data: result.data });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const deleted = await deleteNamedAgent(agentId);

  if (!deleted) {
    return NextResponse.json({ error: "Named agent not found" }, { status: 404 });
  }

  return NextResponse.json({ data: { deleted: true } });
}
