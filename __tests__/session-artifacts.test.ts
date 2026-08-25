import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  attachSessionArtifact,
  MAX_SESSION_ARTIFACT_BYTES,
  SessionArtifactError,
} from "@/lib/agent-sessions/artifacts";
import { createTestDb } from "@/lib/db/test-utils";
import {
  agentSessions,
  epics,
  projects,
  sessionArtifacts,
} from "@/lib/db/schema";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_HEADER = Buffer.from("RIFF0000WEBP", "ascii");
const IMAGE_CASES: Array<[string, Buffer, string]> = [
  ["proof.png", PNG_HEADER, ".png"],
  ["proof.jpg", JPEG_HEADER, ".jpg"],
  ["proof.jpeg", JPEG_HEADER, ".jpeg"],
  ["proof.webp", WEBP_HEADER, ".webp"],
];

let fixture: ReturnType<typeof createTestDb>;
let temporaryRoot: string;
let worktree: string;
let sessionsRoot: string;

const projectId = "project-artifacts";
const epicId = "epic-artifacts";
const sessionId = "session-artifacts";

function writeWorktreeFile(name: string, bytes: Buffer): string {
  const filePath = path.join(worktree, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function attach(sourcePath: string, caption = "The completed UI state") {
  return attachSessionArtifact(
    { sessionId, projectId, sourcePath, caption },
    { database: fixture.db, sessionsRoot }
  );
}

function expectArtifactError(
  callback: () => unknown,
  code: SessionArtifactError["code"]
) {
  try {
    callback();
    throw new Error("Expected attachSessionArtifact to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SessionArtifactError);
    expect((error as SessionArtifactError).code).toBe(code);
    expect((error as Error).message.length).toBeGreaterThan(20);
  }
}

beforeEach(() => {
  fixture = createTestDb();
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arij-artifact-test-"));
  worktree = path.join(temporaryRoot, "worktree");
  sessionsRoot = path.join(temporaryRoot, "sessions");
  fs.mkdirSync(worktree, { recursive: true });

  const now = new Date().toISOString();
  fixture.db
    .insert(projects)
    .values({ id: projectId, name: "Artifacts", createdAt: now, updatedAt: now })
    .run();
  fixture.db
    .insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Visual proofs",
      status: "in_progress",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  fixture.db
    .insert(agentSessions)
    .values({
      id: sessionId,
      projectId,
      epicId,
      worktreePath: worktree,
      status: "running",
      agentType: "build",
      createdAt: now,
    })
    .run();
});

afterEach(() => {
  fixture.sqlite.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("attachSessionArtifact", () => {
  it("copies immediately into durable session storage and persists the row", () => {
    const sourceBytes = Buffer.concat([PNG_HEADER, Buffer.from("visual proof")]);
    writeWorktreeFile("screenshots/result.png", sourceBytes);

    const artifact = attach("screenshots/result.png", "  Saved preferences  ");
    const destination = path.join(
      sessionsRoot,
      sessionId,
      "artifacts",
      artifact.filename
    );

    expect(artifact).toMatchObject({
      agentSessionId: sessionId,
      epicId,
      caption: "Saved preferences",
    });
    expect(path.extname(artifact.filename)).toBe(".png");
    expect(fs.readFileSync(destination)).toEqual(sourceBytes);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(
      fixture.db
        .select()
        .from(sessionArtifacts)
        .where(eq(sessionArtifacts.id, artifact.id))
        .get()
    ).toEqual(artifact);

    fs.rmSync(worktree, { recursive: true });
    expect(fs.readFileSync(destination)).toEqual(sourceBytes);
  });

  it.each(IMAGE_CASES)("accepts %s only when its magic bytes agree", (name, header, extension) => {
    writeWorktreeFile(name, header);
    expect(attach(name).filename.endsWith(extension)).toBe(true);
  });

  it("rejects lexical traversal and absolute paths outside the worktree", () => {
    const outside = path.join(temporaryRoot, "outside.png");
    fs.writeFileSync(outside, PNG_HEADER);

    expectArtifactError(() => attach("../outside.png"), "PATH_OUTSIDE_WORKTREE");
    expectArtifactError(() => attach(outside), "PATH_OUTSIDE_WORKTREE");
  });

  it("rejects an in-worktree symlink that resolves outside the worktree", () => {
    const outside = path.join(temporaryRoot, "outside.png");
    fs.writeFileSync(outside, PNG_HEADER);
    fs.symlinkSync(outside, path.join(worktree, "linked.png"));

    expectArtifactError(() => attach("linked.png"), "PATH_OUTSIDE_WORKTREE");
  });

  it("rejects unsupported, unrecognized, and extension-mismatched files", () => {
    writeWorktreeFile("proof.gif", Buffer.from("GIF89a"));
    writeWorktreeFile("fake.png", Buffer.from("plain text"));
    writeWorktreeFile("mismatch.jpg", PNG_HEADER);

    expectArtifactError(() => attach("proof.gif"), "INVALID_FILE_TYPE");
    expectArtifactError(() => attach("fake.png"), "INVALID_FILE_TYPE");
    expectArtifactError(() => attach("mismatch.jpg"), "INVALID_FILE_TYPE");
  });

  it("accepts exactly 5 MiB and rejects any larger file before copying", () => {
    const atLimit = Buffer.alloc(MAX_SESSION_ARTIFACT_BYTES);
    PNG_HEADER.copy(atLimit);
    writeWorktreeFile("at-limit.png", atLimit);
    expect(attach("at-limit.png")).toBeDefined();

    const overLimitPath = writeWorktreeFile("over-limit.png", PNG_HEADER);
    fs.truncateSync(overLimitPath, MAX_SESSION_ARTIFACT_BYTES + 1);
    expectArtifactError(() => attach("over-limit.png"), "FILE_TOO_LARGE");
  });

  it("allows the tenth artifact and rejects the eleventh", () => {
    const now = new Date().toISOString();
    fixture.db
      .insert(sessionArtifacts)
      .values(
        Array.from({ length: 9 }, (_, index) => ({
          id: `existing-${index}`,
          agentSessionId: sessionId,
          epicId,
          filename: `existing-${index}.png`,
          caption: `Existing artifact ${index}`,
          createdAt: now,
        }))
      )
      .run();
    writeWorktreeFile("tenth.png", PNG_HEADER);
    writeWorktreeFile("eleventh.png", PNG_HEADER);

    expect(attach("tenth.png")).toBeDefined();
    expectArtifactError(
      () => attach("eleventh.png"),
      "ARTIFACT_LIMIT_REACHED"
    );
    expect(
      fixture.db
        .select()
        .from(sessionArtifacts)
        .where(eq(sessionArtifacts.agentSessionId, sessionId))
        .all()
    ).toHaveLength(10);
  });
});
