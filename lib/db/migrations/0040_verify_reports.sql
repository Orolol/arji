-- Durable reports for Arij-owned deterministic verification commands.
--
-- A report belongs to one project and epic. The optional agent session links
-- pipeline-triggered verification to the code run that produced the worktree;
-- manual verification has no session. Commands are stored as one ordered JSON
-- array because their configured names and count vary by project.
--
-- This is a new table rather than an ALTER, so IF NOT EXISTS also makes the
-- migration safe for legacy databases whose schema exists without Drizzle's
-- bookkeeping. No POST_BASELINE_COLUMN_MIGRATIONS entry is needed.
CREATE TABLE IF NOT EXISTS `verify_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`epic_id` text NOT NULL,
	`agent_session_id` text,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text NOT NULL,
	`commands` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `verify_reports_epic_finished_idx` ON `verify_reports` (`epic_id`,`finished_at`);
