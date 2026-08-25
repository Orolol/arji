-- Structured, project-scoped DevX friction reported through the agent MCP
-- channel. Session attribution is deliberately not a foreign key so reports
-- survive later session cleanup; the bearer token remains the write authority.
CREATE TABLE IF NOT EXISTS `frictions` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `epic_id` text,
  `agent_session_id` text NOT NULL,
  `category` text NOT NULL CHECK (`category` IN ('broken_tooling', 'misleading_docs', 'flaky_test', 'unclear_convention', 'other')),
  `description` text NOT NULL,
  `file_path` text,
  `occurrences` integer NOT NULL DEFAULT 1 CHECK (`occurrences` >= 1),
  `status` text NOT NULL DEFAULT 'new' CHECK (`status` IN ('new', 'triaged', 'converted', 'dismissed')),
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `frictions_project_status_occurrences_idx` ON `frictions` (`project_id`, `status`, `occurrences`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `frictions_open_dedupe_idx` ON `frictions` (`project_id`, `category`, `file_path`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `frictions_session_idx` ON `frictions` (`agent_session_id`);
