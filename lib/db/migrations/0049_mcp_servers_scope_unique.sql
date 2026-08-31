-- Per-scope uniqueness for `mcp_servers.name`, enforced by the database.
--
-- 0048 left this to the service layer (lib/mcp/servers.ts existingName) on the
-- stated grounds that a UNIQUE index "could not express unique-among-the-globals
-- because SQLite treats NULLs as distinct". That reasoning was wrong: it holds
-- for a plain UNIQUE(project_id, name), but SQLite has supported PARTIAL
-- indexes since 3.8.0, and two of them express both scopes exactly.
--
-- This matters because the whole shadowing model rests on "one row per name per
-- scope": resolveExtraMcpServers drops a global when a project row shares its
-- name, and disableGlobalForProject creates such a row. With duplicates
-- possible, resolution order would be silently non-deterministic. The service
-- check stays — it produces the friendly 409 — but it is no longer the only
-- thing standing between the invariant and a writer that bypasses it.
CREATE UNIQUE INDEX IF NOT EXISTS `mcp_servers_global_name_uq`
  ON `mcp_servers` (`name`) WHERE `project_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `mcp_servers_project_name_uq`
  ON `mcp_servers` (`project_id`, `name`) WHERE `project_id` IS NOT NULL;
