-- Optional same-provider effort escalation for autonomous pipeline retries.
--
-- The target is another named agent so the higher model remains an ordinary,
-- traceable agent choice on agent_sessions.named_agent_id. Deleting the target
-- simply disables the escalation. Graph validation (same provider, no cycles)
-- lives in the named-agent write service because SQLite cannot express an
-- acyclic self-referential graph as a CHECK constraint.
ALTER TABLE named_agents ADD COLUMN escalates_to text REFERENCES named_agents(id) ON DELETE SET NULL;
