import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { detectRemote } from "@/lib/git/remote";

export async function POST(
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
      { error: "not_found", message: "Project not found." },
      { status: 404 }
    );
  }

  if (!project.gitRepoPath) {
    return NextResponse.json(
      { error: "not_configured", message: "No git repository path configured for this project." },
      { status: 400 }
    );
  }

  const result = await detectRemote(project.gitRepoPath);

  if (!result) {
    return NextResponse.json(
      { error: "no_remote", message: "No origin remote found or URL could not be parsed." },
      { status: 400 }
    );
  }

  return NextResponse.json({ data: result });
}
