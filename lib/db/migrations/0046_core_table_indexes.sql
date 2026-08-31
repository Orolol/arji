-- Secondary indexes on the hot foreign keys of the core tables.
--
-- epics, user_stories, agent_sessions and ticket_comments predate the
-- indexing discipline the newer tables were built with: they carry only their
-- primary-key autoindex, so every project- or epic-scoped lookup is a full
-- table SCAN. better-sqlite3 is synchronous on one shared connection
-- (lib/db/index.ts), so those scans block the event loop for every other
-- request, the SSE heartbeats and the Full Auto sweep — the cost is global,
-- not per-request.
--
-- Column order is chosen so each index serves the query shape that reads it:
--
--   epics(project_id, status, position)
--     The board query filters by project, buckets by status and orders by
--     position. EXPLAIN QUERY PLAN goes from SCAN epics to
--     SEARCH epics USING INDEX (project_id=?), with the ORDER BY satisfied
--     by the index rather than a temp b-tree.
--   user_stories(epic_id, position)
--     Stories are always read epic-scoped and rendered in position order.
--   agent_sessions(project_id, created_at)
--     The sessions list is project-scoped and keyset-paged on creation time.
--     The leading key prunes the scan; the trailing one does NOT remove the
--     sort, because the route orders by `coalesce(created_at, '')` and SQLite
--     cannot match an expression to a plain column index. It still narrows
--     the keyset range the sort has to consider.
--   agent_sessions(epic_id)
--     Ticket detail, pipeline ownership checks and the Full Auto sweep all
--     ask "which sessions belong to this epic?".
--   ticket_comments(epic_id) / ticket_comments(user_story_id)
--     Two separate single-column indexes, not one composite: a comment hangs
--     off exactly one of the two, and each side is queried on its own.
--
-- IF NOT EXISTS keeps the migration a no-op on databases that already carry
-- the indexes, which is what makes it safe to replay.
CREATE INDEX IF NOT EXISTS `epics_project_status_position_idx` ON `epics` (`project_id`, `status`, `position`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `user_stories_epic_position_idx` ON `user_stories` (`epic_id`, `position`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_sessions_project_created_at_idx` ON `agent_sessions` (`project_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `agent_sessions_epic_idx` ON `agent_sessions` (`epic_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ticket_comments_epic_idx` ON `ticket_comments` (`epic_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ticket_comments_user_story_idx` ON `ticket_comments` (`user_story_id`);
