/**
 * Resolve a registered visual proof to its durable bytes. Both the URL's
 * artifact id and every database-derived path segment are treated as
 * untrusted: only a regular image file inside that session's artifact
 * directory is servable.
 */

import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, type ArijDatabase } from "@/lib/db";
import { agentSessions, sessionArtifacts } from "@/lib/db/schema";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export interface ServableSessionArtifact {
  servable: true;
  absolutePath: string;
  mimeType: string;
}

export type SessionArtifactLookup =
  | ServableSessionArtifact
  | { servable: false; reason: "not-registered" | "missing-on-disk" };

interface LookupOptions {
  database?: ArijDatabase;
  sessionsRoot?: string;
}

function isSafeSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    path.basename(value) === value
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function lookupServableSessionArtifact(
  projectId: string,
  artifactId: unknown,
  options: LookupOptions = {}
): SessionArtifactLookup {
  if (!isSafeSegment(artifactId)) {
    return { servable: false, reason: "not-registered" };
  }

  const database = options.database ?? db;
  const row = database
    .select({
      id: sessionArtifacts.id,
      agentSessionId: sessionArtifacts.agentSessionId,
      filename: sessionArtifacts.filename,
      projectId: agentSessions.projectId,
    })
    .from(sessionArtifacts)
    .innerJoin(
      agentSessions,
      eq(agentSessions.id, sessionArtifacts.agentSessionId)
    )
    .where(
      and(
        eq(sessionArtifacts.id, artifactId),
        eq(agentSessions.projectId, projectId)
      )
    )
    .get();

  // Keep an explicit post-query scope check as defense in depth and so a
  // future query refactor cannot accidentally make ids cross-project.
  if (
    !row ||
    row.id !== artifactId ||
    row.projectId !== projectId ||
    !isSafeSegment(row.agentSessionId) ||
    !isSafeSegment(row.filename)
  ) {
    return { servable: false, reason: "not-registered" };
  }

  const mimeType = MIME_BY_EXTENSION[path.extname(row.filename).toLowerCase()];
  if (!mimeType) {
    return { servable: false, reason: "not-registered" };
  }

  const sessionsRoot = path.resolve(
    options.sessionsRoot ?? path.join(process.cwd(), "data", "sessions")
  );
  const artifactDirectory = path.resolve(
    sessionsRoot,
    row.agentSessionId,
    "artifacts"
  );
  const candidate = path.resolve(artifactDirectory, row.filename);

  if (
    !isWithin(sessionsRoot, artifactDirectory) ||
    path.dirname(candidate) !== artifactDirectory
  ) {
    return { servable: false, reason: "not-registered" };
  }

  if (!fs.existsSync(candidate)) {
    return { servable: false, reason: "missing-on-disk" };
  }

  try {
    const realRoot = fs.realpathSync(sessionsRoot);
    const realDirectory = fs.realpathSync(artifactDirectory);
    const realCandidate = fs.realpathSync(candidate);
    if (
      !isWithin(realRoot, realCandidate) ||
      path.dirname(realCandidate) !== realDirectory ||
      !fs.statSync(realCandidate).isFile()
    ) {
      return { servable: false, reason: "not-registered" };
    }
    return { servable: true, absolutePath: realCandidate, mimeType };
  } catch {
    return { servable: false, reason: "missing-on-disk" };
  }
}
