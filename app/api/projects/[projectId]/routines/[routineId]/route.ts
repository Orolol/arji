import { NextRequest, NextResponse } from "next/server";
import {
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import {
  deleteProjectRoutine,
  RoutineConflictError,
  RoutineInputError,
  RoutineNotFoundError,
  updateProjectRoutine,
} from "@/lib/routines/crud";
import { updateRoutineSchema } from "@/lib/routines/validation";
import { isValidationError, validateBody } from "@/lib/validation/validate";

type Params = {
  params: Promise<{ projectId: string; routineId: string }>;
};

function routineError(error: unknown): NextResponse | null {
  if (error instanceof RoutineNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof RoutineConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof RoutineInputError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return null;
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const { projectId, routineId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const validated = await validateBody(updateRoutineSchema, request);
  if (isValidationError(validated)) return validated;

  try {
    return NextResponse.json({
      data: updateProjectRoutine(projectId, routineId, validated.data),
    });
  } catch (error) {
    const response = routineError(error);
    if (response) return response;
    throw error;
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { projectId, routineId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  try {
    deleteProjectRoutine(projectId, routineId);
    return NextResponse.json({ data: { deleted: true } });
  } catch (error) {
    const response = routineError(error);
    if (response) return response;
    throw error;
  }
}
