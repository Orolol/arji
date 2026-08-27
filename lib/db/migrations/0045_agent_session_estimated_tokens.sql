-- Estimated prompt tokens and section breakdown calculated at dispatch time.
-- NULL for legacy rows and sessions where estimation was not run.
ALTER TABLE agent_sessions ADD COLUMN estimated_prompt_tokens INTEGER;
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN estimated_prompt_breakdown TEXT;
