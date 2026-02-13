CREATE TABLE `agent_session_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`stream_type` text NOT NULL,
	`sequence` integer NOT NULL,
	`chunk_key` text,
	`content` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_chunks_session_sequence_unique` ON `agent_session_chunks` (`session_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_chunks_session_stream_key_unique` ON `agent_session_chunks` (`session_id`,`stream_type`,`chunk_key`);--> statement-breakpoint
CREATE INDEX `agent_session_chunks_session_stream_sequence_idx` ON `agent_session_chunks` (`session_id`,`stream_type`,`sequence`);--> statement-breakpoint
CREATE TABLE `agent_session_sequences` (
	`session_id` text PRIMARY KEY NOT NULL,
	`next_sequence` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `named_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `named_agents_name_unique` ON `named_agents` (`name`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text,
	`user_story_id` text,
	`status` text DEFAULT 'queued',
	`mode` text DEFAULT 'code',
	`orchestration_mode` text DEFAULT 'solo',
	`provider` text DEFAULT 'claude-code',
	`prompt` text,
	`logs_path` text,
	`branch_name` text,
	`worktree_path` text,
	`started_at` text,
	`ended_at` text,
	`completed_at` text,
	`last_non_empty_text` text,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_sessions`("id", "project_id", "epic_id", "user_story_id", "status", "mode", "orchestration_mode", "provider", "prompt", "logs_path", "branch_name", "worktree_path", "started_at", "ended_at", "completed_at", "last_non_empty_text", "error", "created_at") SELECT "id", "project_id", "epic_id", "user_story_id", "status", "mode", "orchestration_mode", "provider", "prompt", "logs_path", "branch_name", "worktree_path", "started_at", "ended_at", "completed_at", "last_non_empty_text", "error", "created_at" FROM `agent_sessions`;--> statement-breakpoint
DROP TABLE `agent_sessions`;--> statement-breakpoint
ALTER TABLE `__new_agent_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `agent_provider_defaults` ADD `named_agent_id` text REFERENCES named_agents(id);--> statement-breakpoint
ALTER TABLE `epics` ADD `type` text DEFAULT 'feature';--> statement-breakpoint
ALTER TABLE `epics` ADD `linked_epic_id` text REFERENCES epics(id);--> statement-breakpoint
ALTER TABLE `epics` ADD `images` text;