CREATE TABLE `ticket_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_story_id` text NOT NULL,
	`author` text NOT NULL,
	`content` text NOT NULL,
	`agent_session_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_story_id`) REFERENCES `user_stories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `user_story_id` text REFERENCES user_stories(id);--> statement-breakpoint
ALTER TABLE `chat_conversations` ADD `status` text DEFAULT 'active';