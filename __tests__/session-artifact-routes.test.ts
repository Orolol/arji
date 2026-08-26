import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";
import {
  agentSessions,
  epics,
  projects,
  sessionArtifacts,
} from "@/lib/db/schema";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<typeof createTestDb> | null,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.db;
  },
  get sqlite() {
    if (!testDb.instance) throw new Error("test db not initialised");
    return testDb.instance.sqlite;
  },
}));

import { GET as getArtifact } from "@/app/api/projects/[projectId]/artifacts/[artifactId]/route";
import { GET as listArtifacts } from "@/app/api/projects/[projectId]/epics/[epicId]/artifacts/route";

const projectId = "project-artifact-route";
const otherProjectId = "project-artifact-route-other";
const epicId = "epic-artifact-route";
const sessionId = "session-artifact-route";
const artifactId = "artifact-route-proof";
const filename = "artifact-route-proof.png";
const durableSessionDir = path.join(
  process.cwd(),
  "data",
  "sessions",
  sessionId
);
const durableFile = path.join(durableSessionDir, "artifacts", filename);
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x70, 0x72, 0x6f, 0x6f,
  0x66,
]);

function db() {
  return testDb.instance!.db;
}

function get(project = projectId, artifact: string = artifactId) {
  return getArtifact(
    mockNextRequest(),
    mockRouteContext({ projectId: project, artifactId: artifact })
  );
}

beforeEach(() => {
  testDb.instance = createTestDb();
  const now = new Date().toISOString();
  db()
    .insert(projects)
    .values([
      { id: projectId, name: "Main", createdAt: now, updatedAt: now },
      { id: otherProjectId, name: "Other", createdAt: now, updatedAt: now },
    ])
    .run();
  db()
    .insert(epics)
    .values({
      id: epicId,
      projectId,
      title: "Visual proof",
      status: "review",
      position: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db()
    .insert(agentSessions)
    .values({ id: sessionId, projectId, epicId, createdAt: now })
    .run();
  db()
    .insert(sessionArtifacts)
    .values({
      id: artifactId,
      agentSessionId: sessionId,
      epicId,
      filename,
      caption: "The settings page after save",
      createdAt: now,
    })
    .run();

  fs.mkdirSync(path.dirname(durableFile), { recursive: true });
  fs.writeFileSync(durableFile, pngBytes);
});

afterEach(() => {
  fs.rmSync(durableSessionDir, { recursive: true, force: true });
});

describe("project session artifact routes", () => {
  it("serves registered image bytes with hardened response headers", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pngBytes);
  });

  it("refuses an artifact through a different project scope", async () => {
    const res = await get(otherProjectId);

    expect(res.status).toBe(404);
  });

  it.each(["../artifact-route-proof", "nested/proof", "..\\proof", "..", ""])(
    "refuses an unsafe artifact id before serving bytes: %s",
    async (unsafeId) => {
      const res = await get(projectId, unsafeId);
      expect(res.status).toBe(404);
    }
  );

  it("re-sniffs the durable bytes instead of trusting the database extension", async () => {
    fs.writeFileSync(durableFile, Buffer.from("not an image"));

    const res = await get();

    expect(res.status).toBe(404);
  });

  it("lists captions only when the epic belongs to the requested project", async () => {
    const main = await listArtifacts(
      mockNextRequest(),
      mockRouteContext({ projectId, epicId })
    );
    const foreign = await listArtifacts(
      mockNextRequest(),
      mockRouteContext({ projectId: otherProjectId, epicId })
    );

    expect(main.status).toBe(200);
    await expect(main.json()).resolves.toEqual({
      data: [
        expect.objectContaining({
          id: artifactId,
          agentSessionId: sessionId,
          epicId,
          caption: "The settings page after save",
        }),
      ],
    });
    expect(foreign.status).toBe(404);
  });
});
