import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execSync } from "node:child_process";
import { initDb, defaultMigrationsFolder } from "@/lib/db/init";

function tableInfo(db: InstanceType<typeof Database>) {
  return db.prepare("PRAGMA table_info(desk_dismissals)").all() as {
    name: string; type: string; notnull: number; pk: number;
  }[];
}

describe("0048_desk_dismissals", () => {
  it("applies on a fresh database", () => {
    const path = "/tmp/migtest/fresh.db";
    execSync(`rm -f ${path} ${path}-wal ${path}-shm`);
    const db = new Database(path);
    initDb(db, { migrationsFolder: defaultMigrationsFolder() });

    const cols = tableInfo(db);
    expect(cols.map((c) => c.name)).toEqual([
      "epic_id", "kind", "signal_at", "dismissed_at",
    ]);
    // Composite PK on (epic_id, kind).
    expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["epic_id", "kind"]);
    // signal_at is the only nullable column.
    expect(cols.filter((c) => c.notnull === 0).map((c) => c.name)).toEqual(["signal_at"]);
    db.close();
  });

  it("keeps the route's upsert to one row per (epic, kind)", () => {
    const path = "/tmp/migtest/upsert.db";
    execSync(`rm -f ${path} ${path}-wal ${path}-shm`);
    const db = new Database(path);
    initDb(db, { migrationsFolder: defaultMigrationsFolder() });

    const upsert = db.prepare(
      "INSERT INTO desk_dismissals (epic_id, kind, signal_at, dismissed_at) VALUES (?,?,?,?) " +
        "ON CONFLICT(epic_id, kind) DO UPDATE SET signal_at=excluded.signal_at, dismissed_at=excluded.dismissed_at",
    );
    upsert.run("e1", "asks", "2026-08-31T09:00:00.000Z", "2026-08-31T09:00:01.000Z");
    upsert.run("e1", "asks", "2026-08-31T10:00:00.000Z", "2026-08-31T10:00:01.000Z");
    // Same epic, different family: a separate row, not a replacement.
    upsert.run("e1", "failed", "2026-08-31T11:00:00.000Z", "2026-08-31T11:00:01.000Z");

    const rows = db
      .prepare("SELECT epic_id, kind, signal_at FROM desk_dismissals ORDER BY kind")
      .all() as { epic_id: string; kind: string; signal_at: string }[];
    expect(rows).toEqual([
      { epic_id: "e1", kind: "asks", signal_at: "2026-08-31T10:00:00.000Z" },
      { epic_id: "e1", kind: "failed", signal_at: "2026-08-31T11:00:00.000Z" },
    ]);
    db.close();
  });
});
