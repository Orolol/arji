ALTER TABLE `chat_conversations` ADD `cli_session_id` text;
--> statement-breakpoint
ALTER TABLE `chat_conversations` ADD `named_agent_id` text REFERENCES named_agents(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `cli_session_id` text;
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `named_agent_id` text REFERENCES named_agents(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE `chat_conversations`
SET `cli_session_id` = COALESCE(`cli_session_id`, `claude_session_id`)
WHERE `claude_session_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `agent_sessions`
SET `cli_session_id` = COALESCE(`cli_session_id`, `claude_session_id`)
WHERE `claude_session_id` IS NOT NULL;
