import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, settings } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { tryExportArjiJson } from "@/lib/sync/export";
import { getProjectOr404, isErrorResponse } from "@/lib/api/route-helpers";
import { updateProjectSchema } from "@/lib/validation/schemas";
import { validateBody, isValidationError } from "@/lib/validation/validate";
import { validatePath } from "@/lib/validation/path";
import { cancelProjectSessions } from "@/lib/projects/cancel-sessions";
import {
  removeProjectClone,
  type CloneRemovalResult,
} from "@/lib/projects/clone-cleanup";
import { GITHUB_CLONE_SOURCE } from "@/lib/projects/clone-provenance";
import { perProjectSettingKeys } from "@/lib/projects/project-settings-keys";
import { deleteProjectUploads } from "@/lib/uploads/attachment-ownership";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  return NextResponse.json({ data: found.project });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const validated = await validateBody(updateProjectSchema, request);
  if (isValidationError(validated)) return validated;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const body = validated.data;

  // An Arij-managed clone owns its own path. Re-pointing one at another
  // directory would carry its deletion rights along to a directory that never
  // earned them, so the path is fixed for as long as the project is a clone.
  // Checked before the path is validated: "you cannot move this" is the real
  // answer, and it does not depend on what is at the other end.
  const isManagedClone = found.project.cloneSource === GITHUB_CLONE_SOURCE;
  if (
    isManagedClone &&
    body.gitRepoPath !== undefined &&
    body.gitRepoPath !== found.project.gitRepoPath
  ) {
    return NextResponse.json(
      {
        error:
          "This project's repository was cloned by Arij; its path cannot be changed. Delete the project and import it again to move it.",
      },
      { status: 400 }
    );
  }

  // Validate gitRepoPath if provided
  if (body.gitRepoPath) {
    const pathResult = await validatePath(body.gitRepoPath);
    if (!pathResult.valid) {
      return NextResponse.json(
        { error: pathResult.error },
        { status: 400 }
      );
    }
  }

  // `cloneSource` and `gitRemoteUrl` are absent from updateProjectSchema and
  // therefore unreachable here: provenance is established once, from the disk,
  // by POST /api/projects.
  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.status !== undefined) updates.status = body.status;
  if (body.gitRepoPath !== undefined) updates.gitRepoPath = body.gitRepoPath;
  if (body.githubOwnerRepo !== undefined) updates.githubOwnerRepo = body.githubOwnerRepo;
  if (body.defaultBranch !== undefined) updates.defaultBranch = body.defaultBranch;
  if (body.spec !== undefined) updates.spec = body.spec;

  db.update(projects).set(updates).where(eq(projects.id, projectId)).run();

  const updated = db.select().from(projects).where(eq(projects.id, projectId)).get();
  tryExportArjiJson(projectId);
  return NextResponse.json({ data: updated });
}

/**
 * Deletes a project.
 *
 * By default this removes database rows only — every directory on disk is left
 * exactly where it is, as it always has been. `?removeDirectory=true` opts in
 * to deleting the working directory too, and is honoured **only** for projects
 * Arij cloned itself (`clone_source = "github"`) whose path is still inside the
 * current projects root. A refusal is not an error: the project is deleted
 * regardless and the response says why the directory was kept.
 *
 * Running agents are always stopped first — the project row cascades into
 * `agent_sessions`, so leaving a live CLI process behind would orphan it.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const found = getProjectOr404(projectId);
  if (isErrorResponse(found)) return found;

  const removeDirectory =
    request.nextUrl.searchParams.get("removeDirectory") === "true";

  const cancelled = cancelProjectSessions(projectId, "Project deleted");

  let directory: CloneRemovalResult | null = null;
  if (removeDirectory) {
    directory = await removeProjectClone({
      gitRepoPath: found.project.gitRepoPath ?? null,
      cloneSource: found.project.cloneSource ?? null,
    });
  }

  // Settings rows are a flat key/value store with no foreign key to projects,
  // so the cascade does not reach them.
  const settingsRemoved = deleteProjectSettings(projectId);

  // Before the project row: the attachment rows cascade away with it, and the
  // files under data/uploads/<projectId> would then have nothing left naming
  // them. Deleting the project is what deletes the last reference to them, so
  // it is also the last chance to remove the bytes.
  const uploads = deleteProjectUploads(projectId);

  db.delete(projects).where(eq(projects.id, projectId)).run();

  return NextResponse.json({
    data: {
      ok: true,
      directoryRemoved: directory?.removed ?? false,
      directory: directory
        ? {
            path: directory.path,
            removed: directory.removed,
            worktreesRemoved: directory.worktreesRemoved,
            worktreesPruned: directory.worktreesPruned,
            reason: directory.reason ?? null,
            message: directory.message ?? null,
            error: directory.error ?? null,
          }
        : null,
      cancelledSessions: cancelled.sessions,
      cancelledActivities: cancelled.activities,
      settingsRemoved,
      uploadsRemoved: uploads.rowsDeleted,
      uploadsDirectoryRemoved: uploads.directoryRemoved,
    },
  });
}

/** Drops every `<key>:<projectId>` settings row. Returns the keys removed. */
function deleteProjectSettings(projectId: string): string[] {
  const keys = perProjectSettingKeys(projectId);
  const existing = db
    .select({ key: settings.key })
    .from(settings)
    .where(inArray(settings.key, keys))
    .all()
    .map((row) => row.key);

  if (existing.length > 0) {
    db.delete(settings).where(inArray(settings.key, existing)).run();
  }

  return existing;
}
