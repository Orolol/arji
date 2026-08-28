-- Third-party MCP servers declared by the user (epic "Serveurs MCP
-- additionnels, globaux et par projet").
--
-- `project_id` NULL = a global server, injected into every project's
-- sessions; a non-NULL value scopes the server to one project. The FK
-- cascade makes per-project cleanup automatic: deleting a project drops
-- its servers. (Unlike the flat `settings` table, this table owns its
-- foreign key, so no perProjectSettingKeys() entry is needed.)
--
-- `name` is unique per scope (global vs project). This file enforces it in
-- the service layer only (lib/mcp/servers.ts); migration 0046 adds the two
-- PARTIAL unique indexes that enforce it in the database. The note that used
-- to sit here — that a UNIQUE index "could not express unique-among-the-globals
-- because SQLite treats NULLs as distinct" — was wrong: it is true of a plain
-- UNIQUE(project_id, name), but a partial index keyed on `project_id IS NULL`
-- expresses it exactly. The service check remains so the API reports a 409
-- rather than a raw constraint error. The name `arij` is reserved by the
-- service as well — it is the control channel.
--
-- `agent_types` NULL = the server applies to every session (agent types
-- AND chat turns); a JSON array restricts it to the listed types ("chat"
-- names CLI chat conversations).
--
-- `env` / `args` / `headers` / `tool_allowlist` are JSON blobs, capped in
-- size by the service; over-sized input is REJECTED with an explicit
-- error, never truncated.
--
-- `last_check_ok` is a tri-state: NULL = never checked.
CREATE TABLE IF NOT EXISTS `mcp_servers` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `name` text NOT NULL,
  `enabled` integer NOT NULL DEFAULT 1,
  `transport` text NOT NULL DEFAULT 'stdio' CHECK (`transport` IN ('stdio', 'http')),
  `command` text,
  `args` text NOT NULL DEFAULT '[]',
  `env` text NOT NULL DEFAULT '{}',
  `url` text,
  `headers` text NOT NULL DEFAULT '{}',
  `agent_types` text,
  `tool_allowlist` text,
  `usage_hint` text,
  `last_checked_at` text,
  `last_check_ok` integer,
  `last_check_error` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mcp_servers_scope_name_idx` ON `mcp_servers` (`project_id`, `name`);
