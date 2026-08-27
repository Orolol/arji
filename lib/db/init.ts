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
 * Migration identities involved in the short-lived 0033 collision between
 * the review-verdict branch and main's grading-reports migration.
 *
 * A database that ran the branch before it was rebased has `review_verdict`
 * at the first timestamp, but no `grading_reports` table. Drizzle only keeps a
 * high-water mark, so it would skip the real 0033 and then fail while applying
 * 0034 because the column already exists. See
 * `repairReviewVerdictMigrationCollision` below.
 */
const GRADING_REPORTS_MIGRATION_MS = 1786713000000;
const REVIEW_VERDICT_MIGRATION_MS = 1786713100000;

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
  {
    folderMillis: 1786712100000,
    table: "agent_sessions",
    column: "input_tokens",
  },
  {
    folderMillis: 1786712100000,
    table: "agent_sessions",
    column: "output_tokens",
  },
  {
    folderMillis: 1786712100000,
    table: "agent_sessions",
    column: "total_cost_usd",
  },
  // 0026_agent_session_batch_run
  {
    folderMillis: 1786712300000,
    table: "agent_sessions",
    column: "batch_run_id",
  },
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
  {
    folderMillis: 1786712700000,
    table: "chat_attachments",
    column: "project_id",
  },
  { folderMillis: 1786712700000, table: "chat_attachments", column: "epic_id" },
  // 0031_notification_message (single column ALTER)
  { folderMillis: 1786712800000, table: "notifications", column: "message" },
  // 0032_review_comment_session. Renumbered off 0031's slot, which main had
  // already taken: the `when` IS the migrator's identity, so a database that
  // ran main's 0031 would have skipped this one forever.
  {
    folderMillis: 1786712900000,
    table: "review_comments",
    column: "agent_session_id",
  },
  // 0034_agent_session_review_verdict. This must remain after main's 0033
  // with its own `when`, otherwise databases that already ran 0033 skip it.
  {
    folderMillis: 1786713100000,
    table: "agent_sessions",
    column: "review_verdict",
  },
  // 0039_named_agent_escalation. Renumbered off 0033's slot, which main's
  // grading-reports migration had already taken: the `when` IS the migrator's
  // identity, so it moved past main's whole tail (0038_frictions) rather than
  // colliding with any migration a database may already have applied.
  {
    folderMillis: 1786713600000,
    table: "named_agents",
    column: "escalates_to",
  },
  // 0042_agent_session_mcp_channel (single column ALTER). Renumbered off
  // 0041's slot, which main's done-epic story repair had already taken: the
  // `when` IS the migrator's identity, so a database that ran main's 0041
  // would have skipped this one forever.
  {
    folderMillis: 1786713900000,
    table: "agent_sessions",
    column: "mcp_channel",
  },
  // 0044_named_agent_options (single transactional migration: the three
  // columns are always present or absent together on real databases).
  // Renumbered off 0041's slot for the same reason as 0042 above: main's
  // tail (0041..0043) had already claimed every timestamp up to
  // 1786714000000, so this one moved past all of them.
  { folderMillis: 1786714100000, table: "named_agents", column: "options" },
  {
    folderMillis: 1786714100000,
    table: "named_agents",
    column: "persona_prompt",
  },
  {
    folderMillis: 1786714100000,
    table: "agent_sessions",
    column: "cli_options",
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
  column: string,
): boolean {
  const row = connection
    .prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?")
    .get(table, column);
  return row !== undefined;
}

/**
 * Repair the exact database state produced by the review-verdict migration
 * while it temporarily occupied main's 0033 journal slot.
 *
 * The old row's timestamp now identifies `0033_grading_reports`, even though
 * that SQL never ran, and `0034_agent_session_review_verdict` is pending even
 * though its column already exists. Apply the missing idempotent table
 * migration, correct the old row's hash, and stamp 0034 as applied. The repair
 * is transactional and preserves every already-persisted review verdict.
 *
 * This deliberately requires the whole collision fingerprint: the ledger's
 * high-water mark is exactly 0033, its hash is not the current grading
 * migration hash, the review-verdict column exists, and grading_reports does
 * not. Other damaged or manually edited databases are not guessed at here.
 */
function repairReviewVerdictMigrationCollision(
  connection: Database.Database,
  migrationsFolder: string,
): void {
  if (
    !tableExists(connection, "__drizzle_migrations") ||
    !columnExists(connection, "agent_sessions", "review_verdict") ||
    tableExists(connection, "grading_reports")
  ) {
    return;
  }

  const latest = connection
    .prepare(
      `SELECT hash, created_at
       FROM "__drizzle_migrations"
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get() as { hash: string; created_at: number } | undefined;

  if (Number(latest?.created_at) !== GRADING_REPORTS_MIGRATION_MS) return;

  const migrations = readMigrationFiles({ migrationsFolder });
  const gradingReportsMigration = migrations.find(
    (migration) => migration.folderMillis === GRADING_REPORTS_MIGRATION_MS,
  );
  const reviewVerdictMigration = migrations.find(
    (migration) => migration.folderMillis === REVIEW_VERDICT_MIGRATION_MS,
  );

  if (!gradingReportsMigration || !reviewVerdictMigration) {
    throw new Error(
      "Cannot repair the review-verdict migration collision: required migrations are missing",
    );
  }
  if (latest?.hash === gradingReportsMigration.hash) return;

  const repair = connection.transaction(() => {
    for (const statement of gradingReportsMigration.sql) {
      connection.exec(statement);
    }
    connection
      .prepare(
        `UPDATE "__drizzle_migrations"
         SET hash = ?
         WHERE created_at = ?`,
      )
      .run(gradingReportsMigration.hash, GRADING_REPORTS_MIGRATION_MS);
    connection
      .prepare(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at")
         VALUES (?, ?)`,
      )
      .run(reviewVerdictMigration.hash, REVIEW_VERDICT_MIGRATION_MS);
  });

  repair();
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
  migrationsFolder: string,
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
    LEGACY_BASELINE_MS,
  );

  const toStamp = migrations.filter((m) => m.folderMillis <= stampCeilingMs);

  connection.exec(
    `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )`,
  );

  const insert = connection.prepare(
    `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`,
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
      "[db-init] named_agents table missing — skipping default agent seed",
    );
    return;
  }

  const existing = connection
    .prepare("SELECT id FROM named_agents WHERE name = ? LIMIT 1")
    .get(DEFAULT_NAMED_AGENT_NAME) as { id: string } | undefined;

  if (!existing) {
    connection
      .prepare(
        "INSERT OR IGNORE INTO named_agents (id, name, provider, model, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      )
      .run(
        nanoid(12),
        DEFAULT_NAMED_AGENT_NAME,
        DEFAULT_NAMED_AGENT_PROVIDER,
        DEFAULT_NAMED_AGENT_MODEL,
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
  options: { migrationsFolder?: string } = {},
): void {
  const migrationsFolder =
    options.migrationsFolder ?? defaultMigrationsFolder();

  repairReviewVerdictMigrationCollision(connection, migrationsFolder);
  stampLegacyBaseline(connection, migrationsFolder);
  migrate(drizzle(connection), { migrationsFolder });
  seedDefaultNamedAgent(connection);
}
