-- Index review_comments by the session that filed each row.
--
-- The unverifiable-review rule (lib/pipeline/findings.ts) asks "did THIS
-- session file rows of its own?" from four sites, and one of them is a
-- correlated EXISTS inside the Full Auto merge gate's conditional aggregate
-- (`cleanReviewVerdictSql`, evaluated per qualifying agent_sessions row in
-- loadAutoModeBoard). Without this index that subquery SCANs review_comments
-- once per candidate review — on a pair of tables nothing prunes, so the cost
-- grows with project age on every sweep.
--
-- EXPLAIN QUERY PLAN on the generated shape goes from
--   CORRELATED SCALAR SUBQUERY / SCAN review_comments
-- to
--   SEARCH review_comments USING COVERING INDEX (agent_session_id=?)
--
-- The existing (epic_id, file_path) index does not serve these lookups: the
-- leading column is wrong.
CREATE INDEX IF NOT EXISTS review_comments_session_idx
  ON review_comments(agent_session_id);
