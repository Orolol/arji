-- Repair story rows stranded in Review by merge paths that completed only
-- their parent epic. Released epics are included because they necessarily
-- passed through Done and may carry the same historical inconsistency.
-- Record one durable activity row per repaired story before changing it.
INSERT INTO ticket_activity_log (
  id,
  project_id,
  epic_id,
  from_status,
  to_status,
  actor,
  reason,
  session_id,
  created_at
)
SELECT
  'repair-completed-story-' || user_stories.id,
  epics.project_id,
  epics.id,
  'review',
  'done',
  'system',
  'Story ' || user_stories.id || ' — repaired after parent epic was already completed',
  NULL,
  CURRENT_TIMESTAMP
FROM user_stories
INNER JOIN epics ON epics.id = user_stories.epic_id
WHERE user_stories.status = 'review'
  AND epics.status IN ('done', 'released');
--> statement-breakpoint
UPDATE user_stories
SET status = 'done'
WHERE status = 'review'
  AND epic_id IN (
    SELECT id
    FROM epics
    WHERE status IN ('done', 'released')
  );
