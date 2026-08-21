import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import { scanProjectDocuments } from "@/lib/documents/scan";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const result = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(result)) return result;
  const { project } = result;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(project.gitRepoPath);
  } catch {
    return NextResponse.json(
      { error: `Project directory not found: ${project.gitRepoPath}` },
      { status: 400 }
    );
  }
  if (!stat.isDirectory()) {
    return NextResponse.json(
      { error: `Project path is not a directory: ${project.gitRepoPath}` },
      { status: 400 }
    );
  }

  try {
    const scan = scanProjectDocuments(project.gitRepoPath);
    return NextResponse.json({ data: scan });
  } catch (error) {
    return errorResponse(error, "Document scan failed.");
  }
}
