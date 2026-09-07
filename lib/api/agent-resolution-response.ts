import { NextResponse } from "next/server";
import { CompositeAgentUnusableError } from "@/lib/agent-config/resolution-errors";

/** An explicit unusable choice is an actionable request error, never a fallback. */
export function compositeAgentErrorResponse(error: unknown): NextResponse | null {
  return error instanceof CompositeAgentUnusableError
    ? NextResponse.json({ error: error.message }, { status: 400 })
    : null;
}

/**
 * Catch resolution failures before a route sends its response (including SSE).
 * Other failures retain the route's existing error handling. Background work
 * remains responsible for its own terminal session/pipeline handling.
 */
export function withAgentResolutionErrors<Args extends unknown[], Result extends Response>(
  handler: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result | NextResponse> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      const response = compositeAgentErrorResponse(error);
      if (response) return response;
      throw error;
    }
  };
}
