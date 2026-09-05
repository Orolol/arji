-- Register the `retention` routine kind.
--
-- `routines.kind` is guarded by a CHECK constraint listing the four kinds
-- 0036 shipped with. SQLite cannot widen a CHECK in place, so adding a fifth
-- dispatcher is the usual rebuild-and-rename, following 0003, 0012 and 0029.
-- Nothing references `routines`, so the drop cannot orphan a child row; the
-- three indexes go with the dropped table and are recreated below.
--
-- Re-running it is harmless: the second pass copies an already-migrated table
-- into an identical shape.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_routines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`time_of_day` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`last_run_at` text,
	`last_status` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `routines_kind_check` CHECK (`kind` IN ('night_run', 'dreaming', 'github_issue_sync', 'ci_watch', 'retention')),
	CONSTRAINT `routines_time_of_day_check` CHECK (
		length(`time_of_day`) = 5
		AND substr(`time_of_day`, 3, 1) = ':'
		AND CAST(substr(`time_of_day`, 1, 2) AS INTEGER) BETWEEN 0 AND 23
		AND CAST(substr(`time_of_day`, 4, 2) AS INTEGER) BETWEEN 0 AND 59
		AND `time_of_day` GLOB '[0-2][0-9]:[0-5][0-9]'
	)
);
--> statement-breakpoint
INSERT INTO `__new_routines`("id", "project_id", "kind", "enabled", "time_of_day", "config", "last_run_at", "last_status") SELECT "id", "project_id", "kind", "enabled", "time_of_day", "config", "last_run_at", "last_status" FROM `routines`;--> statement-breakpoint
DROP TABLE `routines`;--> statement-breakpoint
ALTER TABLE `__new_routines` RENAME TO `routines`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `routines_project_kind_unique` ON `routines` (`project_id`, `kind`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `routines_project_idx` ON `routines` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `routines_enabled_idx` ON `routines` (`enabled`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
