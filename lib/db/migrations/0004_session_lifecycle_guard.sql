ALTER TABLE `agent_sessions` ADD `ended_at` text;
--> statement-breakpoint
UPDATE `agent_sessions`
SET `status` = 'queued'
WHERE `status` = 'pending';
--> statement-breakpoint
UPDATE `agent_sessions`
SET `ended_at` = `completed_at`
WHERE `ended_at` IS NULL
  AND `completed_at` IS NOT NULL;
