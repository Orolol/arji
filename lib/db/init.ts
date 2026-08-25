import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { nanoid } from "nanoid";
import path from "path";

/**
 * Default global named agent seeded on first startup.
 *
 * The model id is intentionally pinned: it was the hardcoded value of the
 * historical seed in lib/db/index.ts, and existing databases already carry it.
 * Changing the default model is a product decision, not a migration concern.
 */
export const DEFAULT_NAMED_AGENT_NAME = "Claude Code";
export const DEFAULT_NAMED_AGENT_PROVIDER = "claude-code";
export const DEFAULT_NAMED_AGENT_MODEL = "claude-opus-4-6";

/**
 * `when` timestamp (journal entry) of the last migration that predates the
 * switch to runtime-applied migrations (0020_epic_release_id).
 *
 * Databases created before that switch got their schema from `drizzle-kit push`
 * and ad-hoc bootstrap DDL, so they have all the tables but no
 * `__drizzle_migrations` bookkeeping. For those we stamp every migration up to
 * and including this timestamp as already applied ("baseline"), so that
 * `migrate()` only runs migrations added after the switch — which are written
 * to be no-ops (IF NOT EXISTS) when the objects already exist.
 *
 * Column-adding migrations cannot be written as no-ops (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`), so `stampLegacyBaseline` additionally stamps
 * those as applied when the column is already present — see
 * POST_BASELINE_COLUMN_MIGRATIONS.
 */
export const LEGACY_BASELINE_MS = 1771372800000;

/**
 * Post-baseline migrations that ADD COLUMNs, keyed by their journal `when`
 * timestamp. On bookkeeping-less databases these are stamped as applied when
 * the column already exists (re-running the ALTER would throw), and left to
 * run normally when it does not.
 */
const POST_BASELINE_COLUMN_MIGRATIONS: Array<{
  folderMillis: number;
  table: string;
  column: string;
}> = [
  // 0023_agent_session_outcome
  { folderMillis: 1786712000000, table: "agent_sessions", column: "outcome" },
  // 0024_agent_session_usage (single transactional migration: the three
  // columns are always present or absent together on real databases)
  { folderMillis: 1786712100000, table: "agent_sessions", column: "input_tokens" },
  { folderMillis: 1786712100000, table: "agent_sessions", column: "output_tokens" },
  { folderMillis: 1786712100000, table: "agent_sessions", column: "total_cost_usd" },
  // 0026_agent_session_batch_run
  { folderMillis: 1786712300000, table: "agent_sessions", column: "batch_run_id" },
  // 0028_project_clone_source (single transactional migration: the three
  // columns are always present or absent together on real databases).
  // Renumbered from 0027 when it collided with 0027_provider_usage_snapshots:
  // the `when` timestamp is the migrator's identity, so it moved to a fresh
  // slot too — a DB that already applied 0027_provider_usage_snapshots must
  // still see this one as pending.
  { folderMillis: 1786712500000, table: "projects", column: "clone_source" },
  { folderMillis: 1786712500000, table: "projects", column: "git_remote_url" },
  { folderMillis: 1786712500000, table: "projects", column: "default_branch" },
  // 0030_chat_attachment_ownership (single transactional migration: the two
  // columns are always present or absent together on real databases)
  { folderMillis: 1786712700000, table: "chat_attachments", column: "project_id" },
  { folderMillis: 1786712700000, table: "chat_attachments", column: "epic_id" },
  // 0031_notification_message (single column ALTER)
  { folderMillis: 1786712800000, table: "notifications", column: "message" },
  // 0032_agent_session_review_verdict (single column ALTER)
  {
    folderMillis: 1786712900000,
    table: "agent_sessions",
    column: "review_verdict",
  },
];

/** Default on-disk location of the drizzle migration files. */
export function defaultMigrationsFolder(): string {
  return path.join(process.cwd(), "lib", "db", "migrations");
}

function tableExists(connection: Database.Database, name: string): boolean {
  const row = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function columnExists(
  connection: Database.Database,
  table: string,
  column: string
): boolean {
  const row = connection
    .prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?")
    .get(table, column);
  return row !== undefined;
}

/**
 * Detect a database that predates runtime migrations (core schema present but
 * no `__drizzle_migrations` table) and mark the legacy migrations as applied
 * without running them.
 *
 * The bookkeeping table mirrors the DDL drizzle's migrator itself uses, and
 * rows are inserted with the same hash/created_at values `migrate()` would
 * have written, so drizzle picks up seamlessly from the baseline.
 */
function stampLegacyBaseline(
  connection: Database.Database,
  migrationsFolder: string
): void {
  if (tableExists(connection, "__drizzle_migrations")) return;
  if (!tableExists(connection, "projects")) return; // fresh DB: let migrate() run the full chain

  const migrations = readMigrationFiles({ migrationsFolder });

  // Column-adding migrations after the baseline cannot be no-op re-runs.
  // When such a column is already present, the schema is provably at least
  // as new as that migration — raise the stamp ceiling to it so drizzle
  // neither re-runs the ALTER (would throw) nor the intermediate no-ops.
  const stampCeilingMs = POST_BASELINE_COLUMN_MIGRATIONS.reduce(
    (ceiling, spec) =>
      spec.folderMillis > ceiling &&
      columnExists(connection, spec.table, spec.column)
        ? spec.folderMillis
        : ceiling,
    LEGACY_BASELINE_MS
  );

  const toStamp = migrations.filter((m) => m.folderMillis <= stampCeilingMs);

  connection.exec(
    `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )`
  );

  const insert = connection.prepare(
    `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`
  );
  const stampAll = connection.transaction(() => {
    for (const migration of toStamp) {
      insert.run(migration.hash, migration.folderMillis);
    }
  });
  stampAll();
}

/**
 * Seed the global default named agent. Idempotent: keyed on the unique agent
 * name. Uses raw sqlite to avoid a circular dependency with
 * lib/agent-config/agent-resolution.ts.
 */
function seedDefaultNamedAgent(connection: Database.Database): void {
  if (!tableExists(connection, "named_agents")) {
    // Extremely old databases may predate named_agents and can't be fully
    // healed here; skip the seed instead of crashing at startup.
    console.warn(
      "[db-init] named_agents table missing — skipping default agent seed"
    );
    return;
  }

  const existing = connection
    .prepare("SELECT id FROM named_agents WHERE name = ? LIMIT 1")
    .get(DEFAULT_NAMED_AGENT_NAME) as { id: string } | undefined;

  if (!existing) {
    connection
      .prepare(
        "INSERT OR IGNORE INTO named_agents (id, name, provider, model, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      )
      .run(
        nanoid(12),
        DEFAULT_NAMED_AGENT_NAME,
        DEFAULT_NAMED_AGENT_PROVIDER,
        DEFAULT_NAMED_AGENT_MODEL
      );
  }
}

/**
 * Bring a database fully up to date: baseline-stamp legacy databases, apply
 * pending drizzle migrations, and seed required rows.
 *
 * Safe to call multiple times and on any database state:
 * - fresh file            -> full migration chain runs
 * - legacy (push-created) -> baseline stamped, only post-baseline no-op
 *                            migrations run
 * - up to date            -> nothing happens
 */
export function initDb(
  connection: Database.Database,
  options: { migrationsFolder?: string } = {}
): void {
  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder();

  stampLegacyBaseline(connection, migrationsFolder);
  migrate(drizzle(connection), { migrationsFolder });
  seedDefaultNamedAgent(connection);
}
