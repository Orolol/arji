-- Composite agents: an ordered fallback list of named agents.
--
-- A composite is a ROW of named_agents carrying kind = 'composite', not a
-- table of its own. That is the structuring decision. agent_provider_defaults
-- .named_agent_id (all 21 agent types, at global and project scope),
-- chat_conversations.named_agent_id, qa_reports.named_agent_id,
-- agent_sessions.named_agent_id and both pickers already address
-- named_agents.id, so a composite becomes assignable everywhere without
-- touching a single foreign key. A separate composite_agents table would have
-- forced every one of those FKs, and every picker, to union two identities.
--
-- A composite owns no provider and no model of its own. The two NOT NULL
-- columns carry documented sentinels instead: provider = 'composite'
-- (COMPOSITE_AGENT_PROVIDER, deliberately absent from PROVIDER_OPTIONS so it
-- can never be spawned) and model = ''. The write service ignores both for a
-- composite, and resolution unfolds to a member before any provider is read.
ALTER TABLE named_agents ADD COLUMN kind text NOT NULL DEFAULT 'simple';--> statement-breakpoint
-- Ordered membership.
--
-- Nesting is refused at write time (a member must be kind = 'simple'), which
-- is what keeps cycle detection out of this feature entirely — there is no
-- graph to walk, only a flat list.
--
-- ON DELETE CASCADE on BOTH sides, and the asymmetry is deliberate: deleting
-- the composite drops its membership rows, while deleting a MEMBER removes it
-- from every composite it belonged to and the composite simply continues with
-- the members it has left. Resolution treats a composite emptied that way as
-- unusable rather than silently falling back to a default agent.
CREATE TABLE IF NOT EXISTS composite_agent_members (
  id text PRIMARY KEY NOT NULL,
  composite_id text NOT NULL REFERENCES named_agents(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES named_agents(id) ON DELETE CASCADE,
  position integer NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP
);--> statement-breakpoint
-- (composite_id, position) is the rank the retry ladder descends; the unique
-- index is what makes "attempt N uses member N" a schema guarantee rather
-- than a convention the write path happens to honour.
CREATE UNIQUE INDEX IF NOT EXISTS composite_agent_members_position_unique ON composite_agent_members (composite_id, position);--> statement-breakpoint
-- One appearance per member: a list that repeats an agent would spend two
-- attempts on the agent that just failed.
CREATE UNIQUE INDEX IF NOT EXISTS composite_agent_members_member_unique ON composite_agent_members (composite_id, member_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS composite_agent_members_member_idx ON composite_agent_members (member_id);
