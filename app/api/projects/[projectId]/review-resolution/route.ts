import { withAgentResolutionErrors } from "@/lib/api/agent-resolution-response";
import { NextRequest, NextResponse } from "next/server";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { isAgentType } from "@/lib/agent-config/constants";
import { resolveAgentForDispatch } from "@/lib/agent-config/agent-resolution";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Preview of the agent that a review dispatch would resolve to, including
 * whether review-provider segregation would redirect away from the
 * builder's provider. Used by the review dispatch dialog.
 *
 * Query params:
 * - agentType (required) — a review agent type, e.g. review_feature
 * - epicId / storyId (optional) — the review target
 * - namedAgentId (optional) — explicit named-agent pick (always wins)
 */
export const GET = withAgentResolutionErrors(async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const searchParams = request.nextUrl.searchParams;
  const agentType = searchParams.get("agentType") ?? "";
  if (!isAgentType(agentType)) {
    return NextResponse.json(
      { error: `Invalid agentType: ${agentType}` },
      { status: 400 }
    );
  }

  const epicId = searchParams.get("epicId") || undefined;
  const storyId = searchParams.get("storyId") || undefined;
  const namedAgentId = searchParams.get("namedAgentId") || null;

  const resolved = await resolveAgentForDispatch(
    agentType,
    projectId,
    namedAgentId,
    { purpose: "review", projectId, epicId, storyId }
  );

  return NextResponse.json({
    data: {
      provider: resolved.provider,
      namedAgentId: resolved.namedAgentId ?? null,
      name: resolved.name ?? null,
      segregated: !!resolved.segregated,
      builderProvider: resolved.builderProvider ?? null,
    },
  });
});
