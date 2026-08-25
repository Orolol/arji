import { NextRequest, NextResponse } from "next/server";
import {
  getProjectOr404,
  isErrorResponse,
} from "@/lib/api/route-helpers";
import {
  isCiAutofixEnabled,
  setCiAutofixEnabled,
} from "@/lib/routines/settings";
import { updateCiAutofixSchema } from "@/lib/routines/validation";
import { isValidationError, validateBody } from "@/lib/validation/validate";

type Params = { params: Promise<{ projectId: string }> };

export async function PUT(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const validated = await validateBody(updateCiAutofixSchema, request);
  if (isValidationError(validated)) return validated;

  setCiAutofixEnabled(projectId, validated.data.enabled);
  return NextResponse.json({
    data: { enabled: isCiAutofixEnabled(projectId) },
  });
}
