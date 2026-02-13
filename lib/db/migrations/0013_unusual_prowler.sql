CREATE TABLE `named_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `named_agents_name_unique` ON `named_agents` (`name`);--> statement-breakpoint
ALTER TABLE `agent_provider_defaults` ADD `named_agent_id` text REFERENCES named_agents(id);