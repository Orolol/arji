CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text,
	`number` integer NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`head_branch` text NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `epics` ADD `pr_number` integer;--> statement-breakpoint
ALTER TABLE `epics` ADD `pr_url` text;--> statement-breakpoint
ALTER TABLE `epics` ADD `pr_status` text;