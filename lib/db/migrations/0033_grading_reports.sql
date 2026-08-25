-- Persist each submit_grading call as one atomic report. The individual
-- criterion results stay together as validated JSON so consumers can select
-- the latest report without reconstructing a submission from separate rows.
CREATE TABLE IF NOT EXISTS `grading_reports` (
  `id` text PRIMARY KEY NOT NULL,
  `epic_id` text NOT NULL,
  `agent_session_id` text,
  `gradings` text NOT NULL,
  `summary` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `grading_reports_epic_created_at_idx` ON `grading_reports` (`epic_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `grading_reports_session_idx` ON `grading_reports` (`agent_session_id`);
