import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const body = await request.json();
  const { ownerRepo } = body as { ownerRepo?: string };

  if (!ownerRepo || typeof ownerRepo !== "string") {
    return NextResponse.json(
      { error: "missing_owner_repo", message: "An ownerRepo value (e.g. 'owner/repo') is required." },
      { status: 400 }
    );
  }

  // Validate format
  const parts = ownerRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return NextResponse.json(
      { error: "invalid_format", message: "ownerRepo must be in 'owner/repo' format." },
      { status: 400 }
    );
  }

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    return NextResponse.json(
      { error: "not_found", message: "Project not found." },
      { status: 404 }
    );
  }

  db.update(projects)
    .set({
      githubOwnerRepo: ownerRepo,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, projectId))
    .run();

  const updated = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  return NextResponse.json({ data: updated });
}
