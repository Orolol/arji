import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { sniffArtifactImageType } from "@/lib/agent-sessions/artifacts";
import { lookupServableSessionArtifact } from "@/lib/agent-sessions/servable-artifacts";

const MIME_BY_TYPE = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;

/** Serve one registered session artifact, scoped through its owning project. */
export async function GET(
  _request: NextRequest,
  {
    params,
  }: { params: Promise<{ projectId: string; artifactId: string }> }
) {
  const { projectId, artifactId } = await params;
  const artifact = lookupServableSessionArtifact(projectId, artifactId);

  if (!artifact.servable) {
    return NextResponse.json(
      {
        error:
          artifact.reason === "missing-on-disk"
            ? "Artifact not found on disk"
            : "Artifact not found",
      },
      { status: 404 }
    );
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(artifact.absolutePath);
  } catch {
    return NextResponse.json(
      { error: "Artifact not found on disk" },
      { status: 404 }
    );
  }
  const sniffedType = sniffArtifactImageType(bytes);
  if (!sniffedType || MIME_BY_TYPE[sniffedType] !== artifact.mimeType) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": artifact.mimeType,
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
