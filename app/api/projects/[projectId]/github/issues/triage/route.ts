import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/route-helpers";
import { GitHubNotConfiguredError } from "@/lib/github/client";
import {
  assertGitHubIssuesConfigured,
  isGitHubIssueSyncDue,
  listTriagedIssues,
  syncProjectGitHubIssues,
} from "@/lib/github/issues";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  try {
    // Asserted before anything else so the answer is the same whether or not a
    // background sync happened to be due for this project.
    assertGitHubIssuesConfigured(projectId);

    if (isGitHubIssueSyncDue(projectId, 15)) {
      await syncProjectGitHubIssues(projectId);
    }

    const label = request.nextUrl.searchParams.get("label");
    const milestone = request.nextUrl.searchParams.get("milestone");
    const data = listTriagedIssues(projectId, { label, milestone });

    return NextResponse.json({ data });
  } catch (error) {
    // A project without a linked repo or a stored PAT is an ordinary,
    // recoverable state, not a server fault: 400 with a `code` the UI branches
    // on, matching epics/:epicId/pr and git/detect-remote.
    if (error instanceof GitHubNotConfiguredError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }
    return errorResponse(error, "Failed to load triage issues.");
  }
}
