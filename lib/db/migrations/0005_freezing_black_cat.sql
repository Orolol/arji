CREATE TABLE `git_sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`branch` text,
	`detail` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
