import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockJsonRequest,
  mockNextRequest,
  mockRouteContext,
} from "@/__tests__/helpers/db-mock";

vi.mock("@/lib/db", async () => {
  const { createTestDb } = await import("@/lib/db/test-utils");
  const created = createTestDb();
  return { db: created.db, sqlite: created.sqlite, ensureDbReady: vi.fn() };
});

const { db } = await import("@/lib/db");
const { projects, routines, settings } = await import("@/lib/db/schema");
const { GET, POST } =
  await import("@/app/api/projects/[projectId]/routines/route");
const { PATCH, DELETE } =
  await import("@/app/api/projects/[projectId]/routines/[routineId]/route");
const { PUT: PUT_AUTOFIX } =
  await import("@/app/api/projects/[projectId]/routines/ci-autofix/route");
const { ciAutofixEnabledSettingKey } = await import("@/lib/routines/settings");

const PROJECT_ID = "routine-project";

function projectParams(projectId = PROJECT_ID) {
  return mockRouteContext({ projectId });
}

function routineParams(routineId: string, projectId = PROJECT_ID) {
  return mockRouteContext({ projectId, routineId });
}

beforeEach(() => {
  db.delete(routines).run();
  db.delete(settings).run();
  db.delete(projects).run();
  db.insert(projects)
    .values([
      { id: PROJECT_ID, name: "Routines" },
      { id: "other-project", name: "Other" },
    ])
    .run();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("project routines CRUD routes", () => {
  it("lists only runnable kinds and reports server scheduling metadata", async () => {
    db.insert(routines)
      .values({
        id: "future-dream",
        projectId: PROJECT_ID,
        kind: "dreaming",
        timeOfDay: "04:00",
      })
      .run();

    const response = await GET(mockNextRequest(), projectParams());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data).toEqual([]);
    expect(
      payload.meta.availableKinds.map((entry: { kind: string }) => entry.kind),
    ).toEqual(["night_run", "github_issue_sync", "ci_watch", "retention"]);
    expect(payload.meta.availableKinds).not.toContainEqual(
      expect.objectContaining({ kind: "dreaming" }),
    );
    expect(payload.meta.serverTimezone).toEqual(expect.any(String));
    expect(payload.meta.ciAutofixEnabled).toBe(false);
  });

  it("creates, updates, reads and deletes a routine in its project", async () => {
    const createResponse = await POST(
      mockJsonRequest({
        kind: "night_run",
        enabled: true,
        timeOfDay: "23:15",
        config: {
          includeBacklog: true,
          failurePolicy: "stop",
          circuitBreaker: 4,
        },
      }),
      projectParams(),
    );
    const created = (await createResponse.json()).data;

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      projectId: PROJECT_ID,
      kind: "night_run",
      enabled: true,
      timeOfDay: "23:15",
      config: {
        includeBacklog: true,
        failurePolicy: "stop",
        circuitBreaker: 4,
      },
      lastRunAt: null,
      lastStatus: null,
    });

    const patchResponse = await PATCH(
      mockJsonRequest({
        kind: "github_issue_sync",
        enabled: false,
        timeOfDay: "06:30",
        config: { intervalMinutes: 45 },
      }),
      routineParams(created.id),
    );
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json()).data).toMatchObject({
      kind: "github_issue_sync",
      enabled: false,
      timeOfDay: "06:30",
      config: { intervalMinutes: 45 },
    });

    const listed = await (await GET(mockNextRequest(), projectParams())).json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].id).toBe(created.id);

    const deleteResponse = await DELETE(
      mockNextRequest({ method: "DELETE" }),
      routineParams(created.id),
    );
    expect(deleteResponse.status).toBe(200);
    expect((await deleteResponse.json()).data.deleted).toBe(true);
    expect(
      (await (await GET(mockNextRequest(), projectParams())).json()).data,
    ).toEqual([]);
  });

  it("preserves CI-watch SHA state while replacing user-editable config", async () => {
    const internalState = {
      epic1: {
        prNumber: 12,
        headSha: "abc",
        state: "failing",
        failureNotified: true,
        autofixAttempted: false,
        autofixSessionId: null,
      },
    };
    db.insert(routines)
      .values({
        id: "ci-routine",
        projectId: PROJECT_ID,
        kind: "ci_watch",
        enabled: true,
        timeOfDay: "00:00",
        config: JSON.stringify({
          intervalMinutes: 15,
          ciWatchState: internalState,
          ciWatchErrorState: { "epic-2": "403:Forbidden" },
        }),
      })
      .run();

    const listed = await (await GET(mockNextRequest(), projectParams())).json();
    expect(listed.data[0].config).toEqual({ intervalMinutes: 15 });

    const response = await PATCH(
      mockJsonRequest({ config: { intervalMinutes: 30 } }),
      routineParams("ci-routine"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.config).toEqual({
      intervalMinutes: 30,
    });

    const stored = db
      .select()
      .from(routines)
      .all()
      .find((row) => row.id === "ci-routine");
    expect(JSON.parse(stored?.config ?? "{}")).toEqual({
      intervalMinutes: 30,
      ciWatchState: internalState,
      ciWatchErrorState: { "epic-2": "403:Forbidden" },
    });
  });

  it("starts missed daily schedules tomorrow instead of firing immediately", async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 7, 25, 23, 15, 0);
    vi.setSystemTime(now);

    const created = await POST(
      mockJsonRequest({
        kind: "night_run",
        enabled: true,
        timeOfDay: "22:00",
        config: {},
      }),
      projectParams(),
    );
    const createdPayload = (await created.json()).data;
    expect(createdPayload.lastRunAt).toBe(now.toISOString());
    // Nothing ran — the claim must read as scheduled, not as a completed run.
    expect(createdPayload.lastStatus).toBe("scheduled");

    const disabled = await POST(
      mockJsonRequest({
        kind: "github_issue_sync",
        enabled: false,
        timeOfDay: "23:30",
        config: {},
      }),
      projectParams(),
    );
    const disabledRoutine = (await disabled.json()).data;
    expect(disabledRoutine.lastRunAt).toBeNull();

    const reenabled = await PATCH(
      mockJsonRequest({ enabled: true, timeOfDay: "22:30" }),
      routineParams(disabledRoutine.id),
    );
    expect((await reenabled.json()).data.lastStatus).toBe("scheduled");
  });

  it("rejects duplicate routine kinds within one project", async () => {
    const input = {
      kind: "ci_watch",
      enabled: true,
      timeOfDay: "00:00",
      config: { intervalMinutes: 15 },
    };
    expect((await POST(mockJsonRequest(input), projectParams())).status).toBe(
      201,
    );

    const duplicate = await POST(mockJsonRequest(input), projectParams());
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toContain("already exists");

    const nightRun = await POST(
      mockJsonRequest({
        kind: "night_run",
        enabled: false,
        timeOfDay: "22:00",
        config: {},
      }),
      projectParams(),
    );
    const nightRunId = (await nightRun.json()).data.id;
    const conflictingUpdate = await PATCH(
      mockJsonRequest({ kind: "ci_watch", config: { intervalMinutes: 30 } }),
      routineParams(nightRunId),
    );
    expect(conflictingUpdate.status).toBe(409);
  });

  it("rejects unavailable kinds, invalid times and malformed configs", async () => {
    const unavailable = await POST(
      mockJsonRequest({
        kind: "dreaming",
        timeOfDay: "03:00",
        config: {},
      }),
      projectParams(),
    );
    expect(unavailable.status).toBe(400);

    const invalidTime = await POST(
      mockJsonRequest({
        kind: "night_run",
        timeOfDay: "25:00",
        config: {},
      }),
      projectParams(),
    );
    expect(invalidTime.status).toBe(400);
    expect((await invalidTime.json()).error).toContain("HH:MM");

    const invalidConfig = await POST(
      mockJsonRequest({
        kind: "ci_watch",
        timeOfDay: "00:00",
        config: { intervalMinutes: 0 },
      }),
      projectParams(),
    );
    expect(invalidConfig.status).toBe(400);
    expect((await invalidConfig.json()).error).toContain("positive integer");
  });

  it("scopes mutation ids to the route project", async () => {
    db.insert(routines)
      .values({
        id: "other-routine",
        projectId: "other-project",
        kind: "night_run",
        timeOfDay: "22:00",
      })
      .run();

    const patch = await PATCH(
      mockJsonRequest({ enabled: false }),
      routineParams("other-routine"),
    );
    const remove = await DELETE(
      mockNextRequest({ method: "DELETE" }),
      routineParams("other-routine"),
    );
    expect(patch.status).toBe(404);
    expect(remove.status).toBe(404);
  });
});

describe("project CI autofix setting", () => {
  it("is opt-in and round-trips an explicit project setting", async () => {
    const enabled = await PUT_AUTOFIX(
      mockJsonRequest({ enabled: true }),
      projectParams(),
    );
    expect(enabled.status).toBe(200);
    expect((await enabled.json()).data.enabled).toBe(true);

    const stored = db
      .select()
      .from(settings)
      .all()
      .find((row) => row.key === ciAutofixEnabledSettingKey(PROJECT_ID));
    expect(stored?.value).toBe("true");

    const disabled = await PUT_AUTOFIX(
      mockJsonRequest({ enabled: false }),
      projectParams(),
    );
    expect((await disabled.json()).data.enabled).toBe(false);
  });

  it("rejects non-boolean values", async () => {
    const response = await PUT_AUTOFIX(
      mockJsonRequest({ enabled: "yes" }),
      projectParams(),
    );
    expect(response.status).toBe(400);
  });
});
