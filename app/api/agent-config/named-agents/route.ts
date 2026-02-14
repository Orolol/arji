import { NextRequest, NextResponse } from "next/server";
import {
  listNamedAgents,
  createNamedAgent,
} from "@/lib/agent-config/named-agents";
import { isAgentProvider } from "@/lib/agent-config/constants";
import { createId } from "@/lib/utils/nanoid";

export async function GET() {
  try {
    const data = await listNamedAgents();
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list named agents" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    const { name, provider, model } = body as {
      name?: string;
      provider?: string;
      model?: string;
    };

    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!provider || !isAgentProvider(provider)) {
      return NextResponse.json(
        { error: "provider must be 'claude-code', 'codex', or 'gemini-cli'" },
        { status: 400 },
      );
    }
    if (!model || typeof model !== "string") {
      return NextResponse.json({ error: "model is required" }, { status: 400 });
    }

    const result = await createNamedAgent({ id: createId(), name, provider, model });
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ data: result.data }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create named agent";
    const status = message.includes("already exists") ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
