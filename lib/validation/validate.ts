import { NextRequest, NextResponse } from "next/server";
import { ZodSchema } from "zod";

export async function validateBody<T>(
  schema: ZodSchema<T>,
  request: NextRequest
): Promise<{ data: T } | NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: result.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  return { data: result.data };
}

/** Type guard: returns true when the result is a NextResponse (validation error) */
export function isValidationError<T>(
  result: { data: T } | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}

/**
 * Like {@link validateBody}, but tolerates a POST with no body at all.
 *
 * A route whose schema has no required field (`POST .../device/start`) would
 * otherwise 400 on `fetch(url, { method: "POST" })` — the most natural way to
 * call it — because `request.json()` rejects on an empty body. An ABSENT body
 * validates as `{}`; a body that is present but malformed is still a 400,
 * since that is a client bug worth reporting rather than swallowing.
 */
export async function validateOptionalBody<T>(
  schema: ZodSchema<T>,
  request: NextRequest
): Promise<{ data: T } | NextResponse> {
  const raw = await request.text().catch(() => "");
  if (raw.trim().length === 0) {
    const empty = schema.safeParse({});
    if (!empty.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: empty.error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }
    return { data: empty.data };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      {
        error: "Validation failed",
        details: result.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  }

  return { data: result.data };
}
