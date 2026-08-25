import { NextRequest, NextResponse } from "next/server";
import {
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import {
  AVAILABLE_ROUTINE_KINDS,
  ROUTINE_KIND_DESCRIPTIONS,
  ROUTINE_KIND_LABELS,
} from "@/lib/routines/constants";
import {
  createProjectRoutine,
  listProjectRoutines,
  RoutineInputError,
} from "@/lib/routines/crud";
import { isCiAutofixEnabled } from "@/lib/routines/settings";
import { createRoutineSchema } from "@/lib/routines/validation";
import { isValidationError, validateBody } from "@/lib/validation/validate";

type Params = { params: Promise<{ projectId: string }> };

function availableKinds() {
  return AVAILABLE_ROUTINE_KINDS.map((kind) => ({
    kind,
    label: ROUTINE_KIND_LABELS[kind],
    description: ROUTINE_KIND_DESCRIPTIONS[kind],
  }));
}

function serverTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}

export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  return NextResponse.json({
    data: listProjectRoutines(projectId),
    meta: {
      availableKinds: availableKinds(),
      serverTimezone: serverTimezone(),
      ciAutofixEnabled: isCiAutofixEnabled(projectId),
    },
  });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const validated = await validateBody(createRoutineSchema, request);
  if (isValidationError(validated)) return validated;

  try {
    const created = createProjectRoutine(projectId, validated.data);
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    if (error instanceof RoutineInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
