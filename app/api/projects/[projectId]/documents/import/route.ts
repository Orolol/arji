import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import {
  getProjectOr404,
  isErrorResponse,
  errorResponse,
} from "@/lib/api/route-helpers";
import {
  importScannedDocuments,
  DOCUMENT_IMPORT_MAX_FILES,
} from "@/lib/documents/import";

/**
 * Imports a user-selected batch of scan results as project documents.
 *
 * Body: `{ relativePaths: string[] }` — the repo-relative paths the user
 * checked in the scan dialog. An empty selection is a client-side no-op by
 * contract; the server rejects it with 400 rather than pretending to import.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const result = getProjectOr404(projectId, { requireGitRepo: true });
  if (isErrorResponse(result)) return result;
  const { project } = result;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const relativePaths = (body as { relativePaths?: unknown })?.relativePaths;
  if (
    !Array.isArray(relativePaths) ||
    relativePaths.some((p) => typeof p !== "string")
  ) {
    return NextResponse.json(
      { error: "relativePaths must be an array of strings." },
      { status: 400 }
    );
  }
  if (relativePaths.length === 0) {
    return NextResponse.json(
      { error: "No files selected." },
      { status: 400 }
    );
  }
  if (relativePaths.length > DOCUMENT_IMPORT_MAX_FILES) {
    return NextResponse.json(
      { error: `Too many files (max ${DOCUMENT_IMPORT_MAX_FILES}).` },
      { status: 400 }
    );
  }

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
    const imported = await importScannedDocuments(
      project.gitRepoPath,
      projectId,
      relativePaths as string[]
    );
    return NextResponse.json({ data: imported });
  } catch (error) {
    return errorResponse(error, "Document import failed.");
  }
}
