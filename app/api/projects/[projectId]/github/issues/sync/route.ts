import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/route-helpers";
import { GitHubNotConfiguredError } from "@/lib/github/client";
import { syncProjectGitHubIssues } from "@/lib/github/issues";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  try {
    const result = await syncProjectGitHubIssues(projectId);
    return NextResponse.json({ data: result });
  } catch (error) {
    // Same recoverable configuration state as GET triage — see that route.
    if (error instanceof GitHubNotConfiguredError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }
    return errorResponse(error, "Failed to sync GitHub issues.");
  }
}
