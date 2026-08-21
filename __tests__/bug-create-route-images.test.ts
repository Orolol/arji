import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dbMockState,
  mockJsonRequest,
  mockRouteContext,
  resetDbMockState,
} from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { dbModuleMock } = await import("@/__tests__/helpers/db-mock");
  return dbModuleMock();
});

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

import { POST } from "@/app/api/projects/[projectId]/bugs/route";

/**
 * The write end of a bug's screenshots. The ticket panel can only render an
 * upload the serving route agrees to hand over, so a path that route would
 * 404 must not reach the column in the first place — whether it points
 * somewhere else entirely or merely names a file nobody ever uploaded.
 */
describe("bug create route images", () => {
  const shot = "data/uploads/proj-1/att-1-screenshot.png";
  const secondShot = "data/uploads/proj-1/att-2-console.png";

  function createBug(body: Record<string, unknown>) {
    return POST(mockJsonRequest(body), mockRouteContext({ projectId: "proj-1" }));
  }

  function insertedBug() {
    return dbMockState.insertCalls[0] as Record<string, unknown>;
  }

  /**
   * Puts a path on record the way `POST /chat/upload` would: one
   * `chat_attachments` row, answering the lookup the route now performs.
   *
   * `epicId`/`chatMessageId` null is what makes it a *staged* upload — the
   * only kind a new bug is allowed to take.
   */
  function registerUpload(
    filePath: string,
    mimeType = "image/png",
    owner: { epicId?: string | null; chatMessageId?: string | null } = {}
  ) {
    dbMockState.getQueue.push({
      id: filePath.split("/").pop(),
      chatMessageId: owner.chatMessageId ?? null,
      projectId: "proj-1",
      epicId: owner.epicId ?? null,
      fileName: "screenshot.png",
      filePath,
      mimeType,
      sizeBytes: 2048,
      createdAt: "2026-08-20T10:00:00.000Z",
    });
  }

  /** Rows the claim reports as taken; anything less is a conflict. */
  function claimTakes(count: number) {
    dbMockState.runResult.changes = count;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetDbMockState();
    fsMock.existsSync.mockReturnValue(true);
    // The route resolves the project before anything else now, so its row is
    // the first `.get()` every request makes.
    dbMockState.getQueue.push({ id: "proj-1", name: "Project 1" });
  });

  it("attaches the uploaded paths to the bug as JSON", async () => {
    registerUpload(shot);
    registerUpload(secondShot);
    claimTakes(2);

    const res = await createBug({
      title: "Board renders blank",
      images: [shot, secondShot],
    });

    expect(res.status).toBe(201);
    expect(insertedBug().images).toBe(JSON.stringify([shot, secondShot]));
    expect(insertedBug().type).toBe("bug");
  });

  it("stores null for a bug reported without a screenshot", async () => {
    await createBug({ title: "No screenshot" });

    expect(insertedBug().images).toBeNull();
  });

  it.each([
    ["a path outside the uploads directory", ["/etc/passwd"]],
    ["another project's upload", ["data/uploads/proj-2/shot.png"]],
    ["a traversal", ["data/uploads/proj-1/../../arij.db"]],
    ["a non-string member", [shot, 7]],
    ["a null member", [null]],
    ["an undefined member", [undefined]],
    ["a bare string instead of an array", shot],
    ["an object", { path: shot }],
  ])("rejects %s without inserting anything", async (_label, images) => {
    // Registered so the shape check is what refuses these, not the lookup.
    registerUpload(shot);

    const res = await createBug({ title: "Crafted", images });

    expect(res.status).toBe(400);
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("names the offending entry so the caller can fix it", async () => {
    const res = await createBug({ title: "Crafted", images: ["/etc/passwd"] });

    await expect(res.json()).resolves.toEqual({
      error: 'Not an upload of this project: "/etc/passwd"',
    });
  });

  it("rejects a well-formed path that was never uploaded", async () => {
    // Right directory, right name shape, no `chat_attachments` row: the panel
    // would show a broken thumbnail and the agent a missing file.
    const res = await createBug({
      title: "Invented path",
      images: ["data/uploads/proj-1/never-uploaded.png"],
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'No such upload: "data/uploads/proj-1/never-uploaded.png"',
    });
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("rejects an upload whose recorded type is not an image", async () => {
    registerUpload("data/uploads/proj-1/att-1-payload.html", "text/html");

    const res = await createBug({
      title: "Not a screenshot",
      images: ["data/uploads/proj-1/att-1-payload.html"],
    });

    expect(res.status).toBe(400);
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("rejects a registered upload whose bytes are gone", async () => {
    registerUpload(shot);
    fsMock.existsSync.mockReturnValue(false);

    const res = await createBug({ title: "Wiped uploads", images: [shot] });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: `Upload is no longer on disk: ${JSON.stringify(shot)}`,
    });
    expect(dbMockState.insertCalls).toHaveLength(0);
  });

  it("rejects the whole bug when only the second screenshot is unusable", async () => {
    registerUpload(shot);
    // secondShot deliberately left unregistered.

    const res = await createBug({
      title: "One good, one invented",
      images: [shot, secondShot],
    });

    expect(res.status).toBe(400);
    // Not "store the half that works": a partial bug is a silently wrong bug.
    expect(dbMockState.insertCalls).toHaveLength(0);
  });
});
