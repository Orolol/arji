import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessionArtifacts } from "@/lib/db/schema";
import { getEpicOr404, isErrorResponse } from "@/lib/api/route-helpers";

type Params = { params: Promise<{ projectId: string; epicId: string }> };

/** List durable visual proofs for one ticket after verifying project scope. */
export async function GET(_request: NextRequest, { params }: Params) {
  const { projectId, epicId } = await params;
  const found = getEpicOr404(projectId, epicId);
  if (isErrorResponse(found)) return found;

  const artifacts = db
    .select({
      id: sessionArtifacts.id,
      agentSessionId: sessionArtifacts.agentSessionId,
      epicId: sessionArtifacts.epicId,
      caption: sessionArtifacts.caption,
      createdAt: sessionArtifacts.createdAt,
    })
    .from(sessionArtifacts)
    .where(eq(sessionArtifacts.epicId, epicId))
    .orderBy(asc(sessionArtifacts.createdAt), asc(sessionArtifacts.id))
    .all();

  return NextResponse.json({ data: artifacts });
}
