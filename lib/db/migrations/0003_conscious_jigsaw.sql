CREATE TABLE `agent_prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_type` text NOT NULL,
	`system_prompt` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_prompts_agent_type_scope_unique` ON `agent_prompts` (`agent_type`,`scope`);--> statement-breakpoint
CREATE TABLE `agent_provider_defaults` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_type` text NOT NULL,
	`provider` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_provider_defaults_agent_type_scope_unique` ON `agent_provider_defaults` (`agent_type`,`scope`);--> statement-breakpoint
CREATE TABLE `custom_review_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`system_prompt` text NOT NULL,
	`scope` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`is_enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_review_agents_name_scope_unique` ON `custom_review_agents` (`name`,`scope`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ticket_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_story_id` text,
	`epic_id` text,
	`author` text NOT NULL,
	`content` text NOT NULL,
	`agent_session_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_ticket_comments`("id", "user_story_id", "epic_id", "author", "content", "agent_session_id", "created_at") SELECT "id", "user_story_id", "epic_id", "author", "content", "agent_session_id", "created_at" FROM `ticket_comments`;--> statement-breakpoint
DROP TABLE `ticket_comments`;--> statement-breakpoint
ALTER TABLE `__new_ticket_comments` RENAME TO `ticket_comments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `orchestration_mode` text DEFAULT 'solo';--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `provider` text DEFAULT 'claude-code';--> statement-breakpoint
ALTER TABLE `chat_conversations` ADD `provider` text DEFAULT 'claude-code';