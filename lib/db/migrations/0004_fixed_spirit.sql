CREATE TABLE `git_sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`operation` text NOT NULL,
	`branch` text,
	`status` text NOT NULL,
	`detail` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `github_owner_repo` text;