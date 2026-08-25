import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/lib/db/test-utils";
import { epics, frictions, projects } from "@/lib/db/schema";
import { mockJsonRequest, mockNextRequest, mockRouteContext } from "@/__tests__/helpers/db-mock";

const testDb = vi.hoisted(() => ({
  instance: null as ReturnType<
    typeof import("@/lib/db/test-utils").createTestDb
  > | null,
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

vi.mock("@/lib/sync/export", () => ({ tryExportArjiJson: vi.fn() }));
vi.mock("@/lib/events/emit", () => ({ emitTicketCreated: vi.fn() }));

import { GET as getFrictions } from "@/app/api/projects/[projectId]/frictions/route";
import { PATCH as patchFriction } from "@/app/api/projects/[projectId]/frictions/[frictionId]/route";
import { POST as createEpic } from "@/app/api/projects/[projectId]/epics/route";

const projectId = "project-frictions";
const otherProjectId = "project-other";

function db() {
  return testDb.instance!.db;
}

function insertFriction(
  id: string,
  overrides: Partial<typeof frictions.$inferInsert> = {},
) {
  db()
    .insert(frictions)
    .values({
      id,
      projectId,
      agentSessionId: `session-${id}`,
      category: "other",
      description: `Description ${id}`,
      occurrences: 1,
      status: "new",
      createdAt: "2026-08-25T10:00:00.000Z",
      ...overrides,
    })
    .run();
}

beforeEach(() => {
  testDb.instance?.sqlite.close();
  testDb.instance = createTestDb();
  const now = "2026-08-25T09:00:00.000Z";
  db()
    .insert(projects)
    .values([
      { id: projectId, name: "Friction Project", createdAt: now, updatedAt: now },
      { id: otherProjectId, name: "Other Project", createdAt: now, updatedAt: now },
    ])
    .run();
});

describe("project friction API", () => {
  it("lists only the project rows by occurrences and reports the open count", async () => {
    insertFriction("low", { occurrences: 1, category: "flaky_test" });
    insertFriction("high", { occurrences: 6, category: "broken_tooling" });
    insertFriction("closed", { occurrences: 9, status: "dismissed" });
    insertFriction("foreign", {
      projectId: otherProjectId,
      occurrences: 20,
    });

    const response = await getFrictions(
      mockNextRequest() as NextRequest,
      mockRouteContext({ projectId }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.frictions.map((row: { id: string }) => row.id)).toEqual([
      "closed",
      "high",
      "low",
    ]);
    expect(json.data.openCount).toBe(2);
  });

  it("dismisses only an open friction in the requested project", async () => {
    insertFriction("open");

    const response = await patchFriction(
      mockJsonRequest({ status: "dismissed" }),
      mockRouteContext({ projectId, frictionId: "open" }),
    );

    expect(response.status).toBe(200);
    expect(db().select().from(frictions).where(eq(frictions.id, "open")).get()?.status)
      .toBe("dismissed");

    const second = await patchFriction(
      mockJsonRequest({ status: "dismissed" }),
      mockRouteContext({ projectId, frictionId: "open" }),
    );
    expect(second.status).toBe(409);

    const foreign = await patchFriction(
      mockJsonRequest({ status: "dismissed" }),
      mockRouteContext({ projectId: otherProjectId, frictionId: "open" }),
    );
    expect(foreign.status).toBe(404);
  });

  it("atomically creates a backlog feature and links the converted friction", async () => {
    insertFriction("convert-me", {
      category: "misleading_docs",
      filePath: "README.md",
      occurrences: 4,
    });

    const response = await createEpic(
      mockJsonRequest({
        title: "Correct misleading setup docs",
        description: "The README names an obsolete command.",
        frictionId: "convert-me",
        // The conversion path owns these invariants rather than trusting UI.
        status: "done",
        type: "bug",
      }),
      mockRouteContext({ projectId }),
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    const created = db().select().from(epics).where(eq(epics.id, json.data.id)).get();
    expect(created).toMatchObject({
      projectId,
      title: "Correct misleading setup docs",
      status: "backlog",
      type: "feature",
    });
    expect(db().select().from(frictions).where(eq(frictions.id, "convert-me")).get())
      .toMatchObject({ status: "converted", epicId: json.data.id });
  });

  it("refuses closed and cross-project conversion without creating a ticket", async () => {
    insertFriction("closed", { status: "dismissed" });
    insertFriction("foreign", { projectId: otherProjectId });

    const closed = await createEpic(
      mockJsonRequest({ title: "Should not exist", frictionId: "closed" }),
      mockRouteContext({ projectId }),
    );
    const foreign = await createEpic(
      mockJsonRequest({ title: "Should not exist either", frictionId: "foreign" }),
      mockRouteContext({ projectId }),
    );

    expect(closed.status).toBe(409);
    expect(foreign.status).toBe(404);
    expect(db().select().from(epics).all()).toHaveLength(0);
  });
});
