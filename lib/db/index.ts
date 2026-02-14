import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { nanoid } from "nanoid";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "arij.db");
export const sqlite = new Database(dbPath);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// ---------------------------------------------------------------------------
// Seed global default named agent (idempotent, uses raw sqlite to avoid
// circular dependency with lib/agent-config/providers.ts)
// ---------------------------------------------------------------------------
{
  const existing = sqlite
    .prepare("SELECT id FROM named_agents WHERE name = ? LIMIT 1")
    .get("Claude Code") as { id: string } | undefined;

  if (!existing) {
    sqlite
      .prepare(
        "INSERT OR IGNORE INTO named_agents (id, name, provider, model, created_at) VALUES (?, ?, ?, ?, datetime('now'))"
      )
      .run(nanoid(12), "Claude Code", "claude-code", "claude-opus-4-6");
  }
}
