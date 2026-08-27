import { NextRequest, NextResponse } from "next/server";
import {
  listNamedAgents,
  createNamedAgent,
} from "@/lib/agent-config/named-agents";
import { createId } from "@/lib/utils/nanoid";
import { createNamedAgentSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

export async function GET() {
  try {
    const data = await listNamedAgents();
    return NextResponse.json({ data });
  } catch (error) {
    // Inline (not errorResponse) to avoid importing lib/db via route-helpers:
    // this route's own data access goes through lib/agent-config/named-agents.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list named agents" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const validated = await validateBody(createNamedAgentSchema, request);
  if (isValidationError(validated)) return validated;

  const { name, provider, model, options, personaPrompt, escalatesTo } =
    validated.data;

  try {
    const result = await createNamedAgent({
      id: createId(),
      name,
      provider,
      model,
      options,
      personaPrompt,
      escalatesTo,
    });
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
