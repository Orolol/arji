import { NextRequest, NextResponse } from "next/server";
import {
  listNamedAgents,
  createNamedAgent,
  createCompositeAgent,
} from "@/lib/agent-config/named-agents";
import { COMPOSITE_AGENT_KIND } from "@/lib/agent-config/constants";
import { createId } from "@/lib/utils/nanoid";
import {
  createCompositeAgentSchema,
  createNamedAgentSchema,
} from "@/lib/validation/schemas";
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

/**
 * Creates a simple agent, or a COMPOSITE when the body carries
 * `kind: 'composite'`.
 *
 * The discriminator is read before validation because the two bodies have no
 * field in common beyond the name: a composite sends `memberIds` and no
 * provider, and running it through the simple schema would reject it on the
 * missing provider rather than on anything the user did.
 */
export async function POST(request: NextRequest) {
  const cloned = request.clone();
  let kind: unknown;
  try {
    kind = (await cloned.json())?.kind;
  } catch {
    // Malformed JSON: let validateBody produce the canonical 400 below.
  }

  if (kind === COMPOSITE_AGENT_KIND) {
    const validated = await validateBody(createCompositeAgentSchema, request);
    if (isValidationError(validated)) return validated;

    try {
      const result = await createCompositeAgent({
        id: createId(),
        name: validated.data.name,
        memberIds: validated.data.memberIds,
      });
      if (result.error) {
        const status = result.error.includes("already exists") ? 409 : 400;
        return NextResponse.json({ error: result.error }, { status });
      }
      return NextResponse.json({ data: result.data }, { status: 201 });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create composite agent";
      const status = message.includes("already exists") ? 409 : 500;
      return NextResponse.json({ error: message }, { status });
    }
  }

  const validated = await validateBody(createNamedAgentSchema, request);
  if (isValidationError(validated)) return validated;

  const { name, provider, model, options, personaPrompt } = validated.data;

  try {
    const result = await createNamedAgent({
      id: createId(),
      name,
      provider,
      model,
      options,
      personaPrompt,
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
