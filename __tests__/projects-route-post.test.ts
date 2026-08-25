/**
 * `POST /api/projects` — the last step of every import, and until now the only
 * project route whose POST had no direct coverage (projects-route.test.ts only
 * exercises GET).
 *
 * Runs against `createTestDb()` (real migration chain, real columns) rather
 * than a query-chain mock: the point of most of these assertions is that a
 * value survives into the columns migration 0028 added, which a mock that
 * records `.values()` calls cannot show. Paths are real temp directories —
 * `validatePath()` stats them — and nothing here touches the network.
 *
 * Provenance is the marker-based design: `clone_source` is never taken from
 * the request (the schema drops it — see clone-lifecycle-provenance.test.ts
 * for the unit layer); the route derives it from the clone marker on disk.
 * These tests pin that derivation end-to-end through the route.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { projects, settings } from "@/lib/db/schema";
import { PROJECTS_ROOT_SETTING_KEY } from "@/lib/projects/workspace-constants";
import { writeCloneMarker } from "@/lib/git/clone-marker";
import { mockJsonRequest, mockNextRequest } from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  return { db: createTestDb().db };
});

import { db } from "@/lib/db";
import { POST } from "@/app/api/projects/route";

const tempDirs: string[] = [];

function repoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arij-project-post-"));
  tempDirs.push(dir);
  return dir;
}

function post(body: unknown) {
  return POST(
    mockJsonRequest(body, { url: "http://localhost:3000/api/projects" })
  );
}

/** The row as SQLite actually holds it, not as the route echoed it back. */
function storedProject(id: string) {
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

/** Points `projects_root` at a fresh temp directory and returns it. */
function configuredRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arij-projects-root-"));
  tempDirs.push(root);

  db.insert(settings)
    .values({ key: PROJECTS_ROOT_SETTING_KEY, value: JSON.stringify(root) })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: JSON.stringify(root) },
    })
    .run();

  return root;
}

/**
 * Reproduces what the clone service leaves on disk: `<owner>-<repo>` inside
 * the managed root, with (or without) Arij's marker in `.git/`. Provenance is
 * only granted for a marked directory inside the current root, so tests that
 * expect `clone_source = "github"` have to earn it the same way a real clone
 * does.
 */
async function cloneDir(
  root: string,
  owner: string,
  repo: string,
  options: { marked?: boolean } = {}
): Promise<string> {
  const dir = path.join(root, `${owner}-${repo}`);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (options.marked ?? true) {
    await writeCloneMarker(dir, {
      owner,
      repo,
      ownerRepo: `${owner}/${repo}`,
      remoteUrl: `https://github.com/${owner}/${repo}.git`,
    });
  }
  return dir;
}

beforeEach(() => {
  db.delete(projects).run();
  db.delete(settings).run();
});

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("POST /api/projects — creation", () => {
  it("creates a project and returns it with 201", async () => {
    const response = await post({ name: "Arij", description: "orchestrator" });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data).toMatchObject({
      name: "Arij",
      description: "orchestrator",
      status: "ideation",
    });
    expect(body.data.id).toBeTruthy();
    expect(storedProject(body.data.id)?.name).toBe("Arij");
  });

  it("defaults every optional field to NULL", async () => {
    const body = await (await post({ name: "Minimal" })).json();
    const row = storedProject(body.data.id);

    expect(row).toMatchObject({
      description: null,
      gitRepoPath: null,
      githubOwnerRepo: null,
      cloneSource: null,
      gitRemoteUrl: null,
      defaultBranch: null,
    });
  });

  it("rejects a missing name with 400 and writes nothing", async () => {
    const response = await post({ description: "no name" });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Validation failed");
    expect(db.select().from(projects).all()).toHaveLength(0);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const response = await POST(
      mockNextRequest({
        method: "POST",
        url: "http://localhost:3000/api/projects",
        body: "{not json",
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Invalid JSON body");
  });

  it("rejects a gitRepoPath that does not exist on disk", async () => {
    const response = await post({
      name: "Ghost",
      gitRepoPath: path.join(os.tmpdir(), "arij-definitely-missing-dir"),
    });

    expect(response.status).toBe(400);
    expect(db.select().from(projects).all()).toHaveLength(0);
  });
});

describe("POST /api/projects — clone metadata", () => {
  it("persists githubOwnerRepo so push/PR/release work with no Connect step", async () => {
    const body = await (
      await post({ name: "Arij", githubOwnerRepo: "Orolol/arij" })
    ).json();

    expect(body.data.githubOwnerRepo).toBe("Orolol/arij");
    expect(storedProject(body.data.id)?.githubOwnerRepo).toBe("Orolol/arij");
  });

  it("persists defaultBranch for later worktree bases", async () => {
    const body = await (
      await post({ name: "Arij", defaultBranch: "develop" })
    ).json();

    expect(storedProject(body.data.id)?.defaultBranch).toBe("develop");
  });
});

describe("POST /api/projects — clone provenance is derived from the disk", () => {
  it("grants github provenance to a marked clone inside the projects root", async () => {
    const root = configuredRoot();
    const dir = await cloneDir(root, "octocat", "hello-world");

    const body = await (await post({ name: "Import", gitRepoPath: dir })).json();
    const row = storedProject(body.data.id);

    expect(row).toMatchObject({
      cloneSource: "github",
      gitRemoteUrl: "https://github.com/octocat/hello-world.git",
      githubOwnerRepo: "octocat/hello-world",
    });
  });

  it("refuses to mark a directory Arij never cloned, whatever the request claims", async () => {
    const root = configuredRoot();
    const dir = await cloneDir(root, "octocat", "hello-world", {
      marked: false,
    });

    // `cloneSource` is not even part of the schema: a request cannot state
    // provenance, only a marker on disk can.
    const body = await (
      await post({
        name: "Impostor",
        gitRepoPath: dir,
        cloneSource: "github",
        gitRemoteUrl: "https://github.com/octocat/hello-world.git",
      })
    ).json();
    const row = storedProject(body.data.id);

    expect(row?.cloneSource).toBeNull();
    // The remote URL is kept — it is useful metadata — but grants nothing.
    expect(row?.gitRemoteUrl).toBe(
      "https://github.com/octocat/hello-world.git"
    );
  });

  it("refuses github provenance for a marked directory outside the root", async () => {
    configuredRoot();
    const outside = repoDir();
    fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
    await writeCloneMarker(outside, {
      owner: "octocat",
      repo: "hello-world",
      ownerRepo: "octocat/hello-world",
      remoteUrl: "https://github.com/octocat/hello-world.git",
    });

    const body = await (
      await post({ name: "Moved", gitRepoPath: outside })
    ).json();

    expect(storedProject(body.data.id)?.cloneSource).toBeNull();
  });

  it("fills githubOwnerRepo from the marker when the request omits it", async () => {
    const root = configuredRoot();
    const dir = await cloneDir(root, "octocat", "hello-world");

    const body = await (await post({ name: "Import", gitRepoPath: dir })).json();

    expect(storedProject(body.data.id)?.githubOwnerRepo).toBe(
      "octocat/hello-world"
    );
  });

  it("still accepts a plain local import with no provenance", async () => {
    const dir = repoDir();

    const response = await post({ name: "Local", gitRepoPath: dir });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(storedProject(body.data.id)).toMatchObject({
      gitRepoPath: dir,
      cloneSource: null,
      gitRemoteUrl: null,
    });
  });
});
