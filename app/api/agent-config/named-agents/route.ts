import { NextRequest, NextResponse } from "next/server";
import { createId } from "@/lib/utils/nanoid";
import {
  createNamedAgent,
  listNamedAgents,
} from "@/lib/agent-config/named-agents";

export async function GET() {
  try {
    const data = await listNamedAgents();
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load named agents" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  const result = await createNamedAgent({
    id: createId(),
    name: typeof body.name === "string" ? body.name : "",
    provider: typeof body.provider === "string" ? body.provider : "",
    model: typeof body.model === "string" ? body.model : "",
  });

  if (!result.data && result.error) {
    const status = result.error.includes("exists") ? 409 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json({ data: result.data }, { status: 201 });
}
