-- Visual proofs have to outlive their source worktrees. The row records the
-- generated basename of the copy under data/sessions/<session>/artifacts/;
-- no agent-controlled source path is persisted.
CREATE TABLE IF NOT EXISTS `session_artifacts` (
  `id` text PRIMARY KEY NOT NULL,
  `agent_session_id` text NOT NULL,
  `epic_id` text NOT NULL,
  `filename` text NOT NULL,
  `caption` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`agent_session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`epic_id`) REFERENCES `epics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_artifacts_session_created_at_idx` ON `session_artifacts` (`agent_session_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_artifacts_epic_created_at_idx` ON `session_artifacts` (`epic_id`, `created_at`);
