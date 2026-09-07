import { NextRequest, NextResponse } from "next/server";
import {
  readDefaultCompositeAgentId,
  setDefaultCompositeAgentId,
} from "@/lib/agent-config/composite-agents";
import { setDefaultCompositeAgentSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";

/**
 * The composite that answers "Default agent".
 *
 * One designation at a time, and that is a property of the storage — it is a
 * single settings key, not a flag column some write path has to keep unique
 * across rows.
 */
export async function GET() {
  try {
    return NextResponse.json({
      data: { compositeAgentId: readDefaultCompositeAgentId() },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to read the default composite agent",
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const validated = await validateBody(setDefaultCompositeAgentSchema, request);
  if (isValidationError(validated)) return validated;

  try {
    const error = setDefaultCompositeAgentId(validated.data.compositeAgentId);
    if (error) {
      const status = error.includes("not found") ? 404 : 400;
      return NextResponse.json({ error }, { status });
    }
    return NextResponse.json({
      data: { compositeAgentId: readDefaultCompositeAgentId() },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to set the default composite agent",
      },
      { status: 500 },
    );
  }
}
