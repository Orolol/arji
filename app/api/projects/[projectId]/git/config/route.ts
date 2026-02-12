import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const project = db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();

  if (!project) {
    return NextResponse.json(
      { error: "Project not found" },
      { status: 404 }
    );
  }

  const ownerRepo = project.githubOwnerRepo || null;

  // Check if a GitHub PAT is stored in settings
  const patRow = db
    .select()
    .from(settings)
    .where(eq(settings.key, "github_pat"))
    .get();

  let tokenSet = false;
  if (patRow) {
    try {
      const value = JSON.parse(patRow.value);
      tokenSet = typeof value === "string" && value.length > 0;
    } catch {
      tokenSet = typeof patRow.value === "string" && patRow.value.length > 0;
    }
  }

  const configured = ownerRepo !== null && tokenSet;

  return NextResponse.json({
    data: {
      configured,
      ownerRepo,
      tokenSet,
    },
  });
}
