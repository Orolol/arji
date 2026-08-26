-- Durable schedules for Arij-owned, process-local routines. The scheduler
-- claims a daily run by writing last_run_at before it launches the action;
-- that timestamp is the restart-safe half of the anti-double-run guard.
CREATE TABLE IF NOT EXISTS `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`time_of_day` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`last_run_at` text,
	`last_status` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `routines_kind_check` CHECK (`kind` IN ('night_run', 'dreaming', 'github_issue_sync', 'ci_watch')),
	CONSTRAINT `routines_time_of_day_check` CHECK (
		length(`time_of_day`) = 5
		AND substr(`time_of_day`, 3, 1) = ':'
		AND CAST(substr(`time_of_day`, 1, 2) AS INTEGER) BETWEEN 0 AND 23
		AND CAST(substr(`time_of_day`, 4, 2) AS INTEGER) BETWEEN 0 AND 59
		AND `time_of_day` GLOB '[0-2][0-9]:[0-5][0-9]'
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `routines_project_idx` ON `routines` (`project_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `routines_enabled_idx` ON `routines` (`enabled`);
