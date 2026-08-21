import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/lib/db/test-utils";
import { mockNextRequest } from "@/__tests__/helpers/db-mock";
import { notificationReadCursor, notifications } from "@/lib/db/schema";

// The routes are pure Drizzle now, so the test runs them against a real
// in-memory database with the full schema rather than asserting SQL strings.
const testDb = vi.hoisted(() => ({ instance: null as ReturnType<
  typeof import("@/lib/db/test-utils").createTestDb
> | null }));

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

// ---- Import route handlers AFTER mocks ----
import { GET } from "@/app/api/notifications/route";
import { POST } from "@/app/api/notifications/read/route";

function makeRequest(url: string): Request {
  return mockNextRequest({ url });
}

function seedNotification(
  id: string,
  createdAt: string,
  title = `notification ${id}`,
  message: string | null = null,
  status = "completed"
): void {
  const { db } = testDb.instance!;
  db.insert(notifications)
    .values({
      id,
      projectId: "p1",
      projectName: "Project One",
      status,
      title,
      message,
      targetUrl: `/projects/p1#${id}`,
      createdAt,
    })
    .run();
}

beforeEach(() => {
  testDb.instance = createTestDb();
  testDb.instance.sqlite
    .prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Project One')")
    .run();
});

describe("GET /api/notifications", () => {
  it("returns empty list with unreadCount 0 when no notifications", async () => {
    const res = await GET(makeRequest("http://localhost/api/notifications"));
    const body = await res.json();

    expect(body.data.notifications).toEqual([]);
    expect(body.data.unreadCount).toBe(0);
  });

  it("counts everything as unread when no read cursor exists", async () => {
    seedNotification("n1", "2026-02-18T12:00:00Z");
    seedNotification("n2", "2026-02-18T11:00:00Z");

    const res = await GET(makeRequest("http://localhost/api/notifications"));
    const body = await res.json();

    expect(body.data.notifications).toHaveLength(2);
    expect(body.data.unreadCount).toBe(2);
  });

  it("returns notifications with correct unread count when cursor exists", async () => {
    seedNotification("n1", "2026-02-18T12:00:00Z");
    seedNotification("n2", "2026-02-18T11:00:00Z");
    testDb
      .instance!.db.insert(notificationReadCursor)
      .values({ id: 1, readAt: "2026-02-18T11:30:00Z" })
      .run();

    const res = await GET(makeRequest("http://localhost/api/notifications"));
    const body = await res.json();

    expect(body.data.notifications).toHaveLength(2);
    expect(body.data.unreadCount).toBe(1);
  });

  it("returns notifications newest first", async () => {
    seedNotification("older", "2026-02-18T09:00:00Z");
    seedNotification("newest", "2026-02-18T15:00:00Z");
    seedNotification("middle", "2026-02-18T12:00:00Z");

    const res = await GET(makeRequest("http://localhost/api/notifications"));
    const body = await res.json();

    expect(body.data.notifications.map((n: { id: string }) => n.id)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
  });

  it("returns the full failure message so the bell can show it (AC1)", async () => {
    seedNotification(
      "n1",
      "2026-02-18T12:00:00Z",
      "Build failed — E-proj-001: Login",
      "The agent session failed without any error message and without any output — the process exited (or was lost) without writing stderr or text.",
      "failed"
    );

    const res = await GET(makeRequest("http://localhost/api/notifications"));
    const body = await res.json();

    const [n] = body.data.notifications as Array<{
      id: string;
      status: string;
      message: string | null;
    }>;
    expect(n.id).toBe("n1");
    expect(n.status).toBe("failed");
    expect(n.message).toMatch(/failed without any error message and without any output/i);
  });

  it("respects limit parameter", async () => {
    seedNotification("n1", "2026-02-18T12:00:00Z");
    seedNotification("n2", "2026-02-18T11:00:00Z");
    seedNotification("n3", "2026-02-18T10:00:00Z");

    const res = await GET(
      makeRequest("http://localhost/api/notifications?limit=2")
    );
    const body = await res.json();

    expect(body.data.notifications).toHaveLength(2);
    // unreadCount is not limited by the page size
    expect(body.data.unreadCount).toBe(3);
  });

  it("clamps limit to 200 max", async () => {
    const res = await GET(
      makeRequest("http://localhost/api/notifications?limit=999")
    );

    expect(res.status).toBe(200);
  });
});

describe("POST /api/notifications/read", () => {
  it("inserts the read cursor and returns ok", async () => {
    const before = new Date().toISOString();
    const res = await POST();
    const body = await res.json();

    expect(body.data.ok).toBe(true);

    const rows = testDb
      .instance!.db.select()
      .from(notificationReadCursor)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].readAt >= before).toBe(true);
  });

  it("moves an existing cursor forward without duplicating the row", async () => {
    testDb
      .instance!.db.insert(notificationReadCursor)
      .values({ id: 1, readAt: "2020-01-01T00:00:00.000Z" })
      .run();

    await POST();

    const rows = testDb
      .instance!.db.select()
      .from(notificationReadCursor)
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].readAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  it("marks everything read so the unread count drops to 0", async () => {
    seedNotification("n1", "2026-02-18T12:00:00Z");
    await POST();

    const res = await GET(makeRequest("http://localhost/api/notifications"));
    const body = await res.json();

    expect(body.data.unreadCount).toBe(0);
  });
});
