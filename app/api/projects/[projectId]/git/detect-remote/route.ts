import { NextRequest, NextResponse } from "next/server";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import {
  detectGitHubRemote as detectRemote,
  GitRepositoryUnavailableError,
} from "@/lib/git/remote";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(found)) return found;
  const { project } = found;

  try {
    const result = await detectRemote(project.gitRepoPath);

    if (!result) {
      return NextResponse.json(
        { error: "No origin remote found or URL could not be parsed." },
        { status: 400 }
      );
    }

    return NextResponse.json({ data: result });
  } catch (error) {
    // Same shared helper as GET github/detect — see that route. This one
    // already 400s when no origin can be parsed, so the unusable path it sits
    // next to must not stay a 500.
    if (error instanceof GitRepositoryUnavailableError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }

    return errorResponse(error, "Failed to inspect git remotes for this project.");
  }
}
