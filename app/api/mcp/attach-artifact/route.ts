/**
 * POST /api/mcp/attach-artifact — copy a visual proof out of the calling
 * agent session's worktree before that worktree can be removed.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse } from "@/lib/api/route-helpers";
import {
  attachSessionArtifact,
  MAX_ARTIFACT_CAPTION_LENGTH,
  SessionArtifactError,
} from "@/lib/agent-sessions/artifacts";
import { requireMcpToken } from "@/lib/mcp/http-auth";
import { validateBody } from "@/lib/validation/validate";

const bodySchema = z
  .object({
    path: z.string().min(1),
    caption: z.string().min(1).max(MAX_ARTIFACT_CAPTION_LENGTH),
  })
  .strict();

export async function POST(request: NextRequest) {
  const auth = requireMcpToken(request);
  if (isErrorResponse(auth)) return auth;

  if (auth.agentType === "chat") {
    return NextResponse.json(
      {
        error: "attach_artifact is only available to ticket agent sessions.",
        code: "FORBIDDEN",
      },
      { status: 403 }
    );
  }

  const validated = await validateBody(bodySchema, request);
  if (isErrorResponse(validated)) return validated;

  try {
    const artifact = attachSessionArtifact({
      sessionId: auth.sessionId,
      projectId: auth.projectId,
      sourcePath: validated.data.path,
      caption: validated.data.caption,
    });
    return NextResponse.json({ data: { artifact } });
  } catch (error) {
    if (error instanceof SessionArtifactError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("[mcp/attach-artifact] Unexpected failure", error);
    return NextResponse.json(
      {
        error: "Arij could not attach this artifact.",
        code: "ARTIFACT_STORAGE_FAILED",
      },
      { status: 500 }
    );
  }
}
