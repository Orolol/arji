import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import type { ArijDatabase } from "@/lib/db";
import {
  agentSessions,
  epics,
  projects,
  sessionArtifacts,
} from "@/lib/db/schema";
import { lookupServableSessionArtifact } from "@/lib/agent-sessions/servable-artifacts";

/**
 * The containment boundary behind GET
 * /api/projects/[projectId]/artifacts/[artifactId] — the one route that reads
 * bytes off disk and streams them to a browser. Every segment it joins is
 * untrusted: the artifact id arrives in the URL, while the session id and the
 * filename come from rows an agent's `attach_artifact` call wrote.
 *
 * The refusals are the interesting half, so each escape below is staged with a
 * real, servable image sitting exactly where the traversal would land. Weaken a
 * check and these tests do not just report a different reason — the lookup
 * hands back a path outside the session's own artifact directory.
 *
 * Everything runs against a real temp directory rather than a mocked `fs`: the
 * symlink cases only mean something if `realpathSync` actually resolves.
 *
 * Mutation-verified check by check. Two clauses of the module cannot be
 * isolated from the outside and are worth knowing about before trusting a
 * green run here:
 *
 *  - `isSafeSegment`'s `!value.includes("/")` and `basename(value) === value`
 *    back each other up on POSIX, so removing either one alone stays green;
 *    removing both is caught. The `\` clause is load-bearing on its own.
 *  - The two static checks after the join (`isWithin(sessionsRoot,
 *    artifactDirectory)` and `dirname(candidate) === artifactDirectory`) are
 *    unreachable while `isSafeSegment` holds — no input reaches them, so no
 *    test can fail when they go. They are the belt to `isSafeSegment`'s
 *    braces; the realpath checks below them are the ones with teeth.
 */

const projectId = "project-servable-artifacts";
const otherProjectId = "project-servable-artifacts-other";
const epicId = "epic-servable-artifacts";
const otherEpicId = "epic-servable-artifacts-other";
const sessionId = "session-servable-artifacts";
const artifactId = "artifact-servable-proof";
const filename = "proof.png";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x72, 0x6f, 0x6f, 0x66,
]);

let fixture: ReturnType<typeof createTestDb>;
let temporaryRoot: string;
let sessionsRoot: string;
/** Outside `sessionsRoot` entirely — stands in for the rest of the disk. */
let outsideRoot: string;

function registerSession(id: string, owner = projectId) {
  fixture.db
    .insert(agentSessions)
    .values({
      id,
      projectId: owner,
      epicId: owner === projectId ? epicId : otherEpicId,
      createdAt: new Date().toISOString(),
    })
    .run();
}

function registerArtifact(
  values: { id?: string; agentSessionId?: string; filename?: string } = {}
) {
  fixture.db
    .insert(sessionArtifacts)
    .values({
      id: values.id ?? artifactId,
      agentSessionId: values.agentSessionId ?? sessionId,
      epicId,
      filename: values.filename ?? filename,
      caption: "The settings page after save",
      createdAt: new Date().toISOString(),
    })
    .run();
}

/** Write real image bytes at `<directory>/<name>`, creating the directory. */
function writeImage(directory: string, name: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, PNG_BYTES);
  return file;
}

function artifactDirectoryFor(session: string): string {
  return path.join(sessionsRoot, session, "artifacts");
}

function lookup(id: unknown = artifactId, project = projectId) {
  return lookupServableSessionArtifact(project, id, {
    database: fixture.db,
    sessionsRoot,
  });
}

/**
 * A database that fails loudly if it is queried at all — the guard on the
 * URL-supplied id has to refuse before any row is fetched.
 */
function databaseThatMustNotBeQueried(): ArijDatabase {
  return {
    select() {
      throw new Error(
        "lookupServableSessionArtifact queried the database for an unsafe artifact id"
      );
    },
  } as unknown as ArijDatabase;
}

beforeEach(() => {
  fixture = createTestDb();
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "arij-servable-artifact-")
  );
  sessionsRoot = path.join(temporaryRoot, "sessions");
  outsideRoot = path.join(temporaryRoot, "outside");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  const now = new Date().toISOString();
  fixture.db
    .insert(projects)
    .values([
      { id: projectId, name: "Main", createdAt: now, updatedAt: now },
      { id: otherProjectId, name: "Other", createdAt: now, updatedAt: now },
    ])
    .run();
  fixture.db
    .insert(epics)
    .values([
      {
        id: epicId,
        projectId,
        title: "Visual proof",
        status: "review",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: otherEpicId,
        projectId: otherProjectId,
        title: "Someone else's work",
        status: "review",
        position: 0,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
  registerSession(sessionId);
});

afterEach(() => {
  fixture.sqlite.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("lookupServableSessionArtifact", () => {
  it("resolves a registered proof to the bytes in its own session directory", () => {
    const file = writeImage(artifactDirectoryFor(sessionId), filename);
    registerArtifact();

    const result = lookup();

    expect(result).toEqual({
      servable: true,
      absolutePath: fs.realpathSync(file),
      mimeType: "image/png",
    });
    expect(fs.readFileSync(result.servable ? result.absolutePath : "")).toEqual(
      PNG_BYTES
    );
  });

  it.each([
    ["shot.png", "image/png"],
    ["shot.jpg", "image/jpeg"],
    ["shot.jpeg", "image/jpeg"],
    ["shot.webp", "image/webp"],
    ["SHOT.PNG", "image/png"],
  ])("serves %s as %s", (name, mimeType) => {
    writeImage(artifactDirectoryFor(sessionId), name);
    registerArtifact({ filename: name });

    expect(lookup()).toMatchObject({ servable: true, mimeType });
  });

  it.each(["proof.svg", "notes.txt", "page.html", "proof", "proof.png.exe"])(
    "refuses %s: the extension is not a servable image",
    (name) => {
      writeImage(artifactDirectoryFor(sessionId), name);
      registerArtifact({ filename: name });

      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    }
  );

  it("refuses an artifact id with no row behind it", () => {
    expect(lookup("never-attached")).toEqual({
      servable: false,
      reason: "not-registered",
    });
  });

  it("refuses an artifact reached through another project's scope", () => {
    writeImage(artifactDirectoryFor(sessionId), filename);
    registerArtifact();

    // The id is real and the bytes exist; only the scope is wrong. A caller
    // who guesses an id must not be able to read another project's proofs.
    expect(lookup(artifactId, otherProjectId)).toEqual({
      servable: false,
      reason: "not-registered",
    });
  });

  describe("a row the query should never have returned", () => {
    /**
     * The scope re-check after the query is defense in depth: the `where`
     * clause already filters on both columns, so nothing reachable through a
     * real database exercises it. Feeding the lookup the row a *refactored*
     * query would hand back is the only way to hold that guard to account —
     * and the refactor it guards against (a dropped join condition, a widened
     * filter) is exactly the kind that reads as harmless in a diff.
     */
    function databaseReturning(row: unknown): ArijDatabase {
      const chain = {
        select: () => chain,
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        get: () => row,
      };
      return chain as unknown as ArijDatabase;
    }

    const soundRow = {
      id: artifactId,
      agentSessionId: sessionId,
      filename,
      projectId,
    };

    function lookupRow(row: unknown) {
      return lookupServableSessionArtifact(projectId, artifactId, {
        database: databaseReturning(row),
        sessionsRoot,
      });
    }

    beforeEach(() => {
      writeImage(artifactDirectoryFor(sessionId), filename);
    });

    it("serves the row when every column matches the request", () => {
      // The control: everything below differs from this by one field, so a
      // refusal there is the guard and not a broken fixture.
      expect(lookupRow(soundRow)).toMatchObject({ servable: true });
    });

    it("refuses a row belonging to a different project", () => {
      expect(lookupRow({ ...soundRow, projectId: otherProjectId })).toEqual({
        servable: false,
        reason: "not-registered",
      });
    });

    it("refuses a row that is not the artifact that was asked for", () => {
      expect(lookupRow({ ...soundRow, id: "some-other-artifact" })).toEqual({
        servable: false,
        reason: "not-registered",
      });
    });

    it("refuses a row with no session or filename at all", () => {
      expect(lookupRow({ ...soundRow, agentSessionId: null })).toEqual({
        servable: false,
        reason: "not-registered",
      });
      expect(lookupRow({ ...soundRow, filename: null })).toEqual({
        servable: false,
        reason: "not-registered",
      });
      expect(lookupRow(undefined)).toEqual({
        servable: false,
        reason: "not-registered",
      });
    });
  });

  describe("the artifact id from the URL", () => {
    it.each([
      ["a traversal", "../../../etc/passwd"],
      ["a decoded separator", "nested/artifact"],
      ["a windows separator", "..\\arij.db"],
      ["an absolute path", "/etc/passwd"],
      ["a null byte", "artifact\u0000.png"],
      ["dot", "."],
      ["dot dot", ".."],
      ["empty", ""],
      ["a non-string", 7],
      ["null", null],
      ["undefined", undefined],
    ])("refuses %s before querying anything", (_label, unsafeId) => {
      expect(
        lookupServableSessionArtifact(projectId, unsafeId, {
          database: databaseThatMustNotBeQueried(),
          sessionsRoot,
        })
      ).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses an unsafe id even when a row was stored under it", () => {
      const unsafeId = "nested/artifact";
      writeImage(artifactDirectoryFor(sessionId), filename);
      registerArtifact({ id: unsafeId });

      // The row is reachable — the lookup must still refuse the shape rather
      // than trust that a stored id was ever validated on the way in.
      expect(
        fixture.db.select().from(sessionArtifacts).all()
      ).toHaveLength(1);
      expect(lookup(unsafeId)).toEqual({
        servable: false,
        reason: "not-registered",
      });
    });
  });

  describe("the filename from the database row", () => {
    it.each([
      ["a traversal", "../escape.png"],
      ["a deep traversal", "../../../escape.png"],
      ["a separator", "nested/escape.png"],
      ["a trailing separator", "proof.png/"],
      ["a windows separator", "..\\escape.png"],
      ["an absolute path", "/etc/escape.png"],
      ["dot", "."],
      ["dot dot", ".."],
      ["empty", ""],
    ])("refuses %s", (_label, unsafeName) => {
      writeImage(artifactDirectoryFor(sessionId), filename);
      registerArtifact({ filename: unsafeName });

      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses a traversal that would otherwise resolve to a real file", () => {
      // `../logs.png` lands one level up, inside the session directory but
      // outside `artifacts/` — a real, readable image the route was never
      // meant to expose.
      fs.mkdirSync(artifactDirectoryFor(sessionId), { recursive: true });
      writeImage(path.join(sessionsRoot, sessionId), "logs.png");
      registerArtifact({ filename: "../logs.png" });

      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses a nested name that would otherwise resolve to a real file", () => {
      // Stays under `artifacts/`, so only the "a name is one segment" rule
      // stands between the caller and an arbitrary subtree walk.
      writeImage(
        path.join(artifactDirectoryFor(sessionId), "nested"),
        "deep.png"
      );
      registerArtifact({ filename: "nested/deep.png" });

      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses a name whose basename is not the name itself", () => {
      // `proof.png/` basenames back to a servable file. On POSIX the separator
      // rule fires first; the `basename(value) === value` clause is what still
      // catches this shape where `path` splits on `\` as well.
      const name = "proof.png/";
      writeImage(artifactDirectoryFor(sessionId), "proof.png");
      registerArtifact({ filename: name });

      expect(path.basename(name)).not.toBe(name);
      expect(fs.existsSync(path.resolve(artifactDirectoryFor(sessionId), name)))
        .toBe(true);
      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses a name carrying a null byte", () => {
      const name = `proof${String.fromCharCode(0)}.png`;
      writeImage(artifactDirectoryFor(sessionId), filename);
      registerArtifact({ filename: name });

      // SQLite stores the byte rather than truncating at it, so the guard —
      // not the store — is what stops a name a C-level API would cut short.
      expect(
        fixture.db
          .select({ filename: sessionArtifacts.filename })
          .from(sessionArtifacts)
          .get()?.filename
      ).toBe(name);
      expect(path.extname(name)).toBe(".png");
      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });
  });

  describe("the session id from the database row", () => {
    it.each([
      ["a traversal", "../outside-session"],
      ["a separator", "nested/session"],
      ["a windows separator", "..\\session"],
      ["an absolute path", "/tmp/session"],
      ["dot", "."],
      ["dot dot", ".."],
    ])("refuses %s", (_label, unsafeSession) => {
      registerSession(unsafeSession);
      writeImage(artifactDirectoryFor(sessionId), filename);
      registerArtifact({ agentSessionId: unsafeSession });

      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses a session id that would climb out of the sessions root", () => {
      const unsafeSession = "../outside-session";
      registerSession(unsafeSession);
      // Resolves to <temp>/outside-session/artifacts/proof.png — a real image
      // sitting outside the directory this route is allowed to read from.
      const escaped = writeImage(
        path.resolve(sessionsRoot, unsafeSession, "artifacts"),
        filename
      );
      expect(escaped.startsWith(sessionsRoot + path.sep)).toBe(false);
      registerArtifact({ agentSessionId: unsafeSession });

      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses a session id that walks into another directory under the root", () => {
      const unsafeSession = "nested/session";
      registerSession(unsafeSession);
      // Still inside `sessionsRoot`, so only the one-segment rule stops the
      // row from naming an arbitrary directory below it.
      writeImage(artifactDirectoryFor(unsafeSession), filename);
      registerArtifact({ agentSessionId: unsafeSession });

      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });
  });

  describe("symlinks", () => {
    it("refuses a link that leaves the sessions root", () => {
      const secret = writeImage(outsideRoot, "secret.png");
      const directory = artifactDirectoryFor(sessionId);
      fs.mkdirSync(directory, { recursive: true });
      fs.symlinkSync(secret, path.join(directory, filename));
      registerArtifact();

      // The name is a clean single segment and the file exists: only
      // resolving the link tells the two cases apart.
      expect(fs.existsSync(path.join(directory, filename))).toBe(true);
      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses a link into another session's artifacts", () => {
      const otherSession = "session-servable-artifacts-neighbour";
      registerSession(otherSession);
      const neighbour = writeImage(
        artifactDirectoryFor(otherSession),
        "neighbour.png"
      );
      const directory = artifactDirectoryFor(sessionId);
      fs.mkdirSync(directory, { recursive: true });
      fs.symlinkSync(neighbour, path.join(directory, filename));
      registerArtifact();

      // Inside the sessions root, so containment alone would allow it: the
      // artifact has to resolve inside *its own* session's directory.
      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("refuses a link when the artifacts directory itself points outside", () => {
      const stolen = path.join(outsideRoot, "stolen");
      writeImage(stolen, filename);
      fs.mkdirSync(path.join(sessionsRoot, sessionId), { recursive: true });
      fs.symlinkSync(stolen, artifactDirectoryFor(sessionId));
      registerArtifact();

      expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
    });

    it("serves a link that stays inside the same artifacts directory", () => {
      // The rule is containment, not "no symlinks" — an alias next to its
      // target resolves to a file the session already owns.
      const directory = artifactDirectoryFor(sessionId);
      const target = writeImage(directory, "original.png");
      fs.symlinkSync(target, path.join(directory, filename));
      registerArtifact();

      expect(lookup()).toEqual({
        servable: true,
        absolutePath: fs.realpathSync(target),
        mimeType: "image/png",
      });
    });

    it("reports a dangling link as missing bytes", () => {
      const directory = artifactDirectoryFor(sessionId);
      fs.mkdirSync(directory, { recursive: true });
      fs.symlinkSync(path.join(outsideRoot, "gone.png"), path.join(directory, filename));
      registerArtifact();

      expect(lookup()).toEqual({ servable: false, reason: "missing-on-disk" });
    });
  });

  it("refuses a directory wearing an image name", () => {
    fs.mkdirSync(path.join(artifactDirectoryFor(sessionId), filename), {
      recursive: true,
    });
    registerArtifact();

    expect(lookup()).toEqual({ servable: false, reason: "not-registered" });
  });

  it("distinguishes a registered proof whose bytes are gone", () => {
    fs.mkdirSync(artifactDirectoryFor(sessionId), { recursive: true });
    registerArtifact();

    // A separate reason from "not-registered": the attachment did happen, so
    // the caller is looking at a wiped `data/` directory, not a crafted path.
    expect(lookup()).toEqual({ servable: false, reason: "missing-on-disk" });
  });
});
