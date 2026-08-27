-- Per-CLI options and persona pre-prompt for named agents.
--
-- `options` is a JSON object keyed by the option keys declared in
-- lib/providers/options-registry.ts, holding only NON-DEFAULT values. An
-- empty object therefore means "everything at the CLI's own default", which
-- is what keeps an unconfigured agent's spawn argv identical to what it was
-- before this column existed. Free-form JSON on purpose: adding an option to
-- the registry must not require a migration, exactly as settings keys and
-- document kinds do not.
--
-- `persona_prompt` is deliberately NULL for existing rows rather than
-- backfilled with the product default ("You're an experienced developer").
-- The persona is injected verbatim at the head of every prompt the agent
-- receives, so backfilling would silently change the prompt of every agent
-- already configured. New agents get the default at creation time (see
-- createNamedAgent); NULL and whitespace both mean "inject nothing".
ALTER TABLE named_agents ADD COLUMN options text NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE named_agents ADD COLUMN persona_prompt text;--> statement-breakpoint
-- The options actually in effect for one session, resolved at spawn time and
-- written before the child starts. Audit trail: the named agent can be edited
-- or deleted afterwards, so the session row has to carry its own copy for the
-- run to stay explainable (and re-playable) after a restart.
ALTER TABLE agent_sessions ADD COLUMN cli_options text;
