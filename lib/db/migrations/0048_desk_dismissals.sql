-- "Your turn" signals the user has waved off.
--
-- The desk's three coral families are DERIVED and never marked: an asks-you row
-- lives as long as `isAwaitingReply` holds, a failure until a newer session
-- supersedes it, a conflict until the branch stops conflicting. Nothing let the
-- user say "I already handled this elsewhere", and `ticket_read_cursors`
-- deliberately does not feed any of the three.
--
-- WHAT `signal_at` MEANS, and why it is not `dismissed_at`:
--
-- It stores the timestamp of the signal that was dismissed — the question's
-- `askedAt`, the failure's `failedAt`, the conflict's `at`. The server hides the
-- row only while the epic's CURRENT signal is no newer than that value. A new
-- question, a new failure or a fresh conflict on the same epic therefore brings
-- the row straight back.
--
-- A permanent per-epic dismissal would have been one column shorter and would
-- have hidden real failures forever, which is precisely what this stratum
-- exists to surface. `dismissed_at` is kept for audit only; nothing branches
-- on it.
--
-- It is NULLABLE because the derived rows are: `askedAt` comes from
-- `agent_sessions.ended_at`, which is null for a session that never recorded
-- one. The filter treats a null current signal as "not newer", so such a row
-- stays dismissed rather than flickering back on the next poll.
--
-- NO FOREIGN KEY, same discipline as `ticket_read_cursors`: this is pure
-- bookkeeping, orphan rows are inert, and joins simply never see them.
--
-- The composite primary key (epic_id, kind) is what makes the route's upsert
-- an ON CONFLICT DO UPDATE — one dismissal per epic per family, re-armed each
-- time the user waves the same family off again. It also serves the read side:
-- the control-desk query fetches dismissals by epic id, and the PK's implicit
-- index covers that lookup, so no separate index is created here.
--
-- IF NOT EXISTS keeps the migration replay-safe.
CREATE TABLE IF NOT EXISTS `desk_dismissals` (
	`epic_id` text NOT NULL,
	`kind` text NOT NULL,
	`signal_at` text,
	`dismissed_at` text NOT NULL,
	PRIMARY KEY(`epic_id`, `kind`)
);
