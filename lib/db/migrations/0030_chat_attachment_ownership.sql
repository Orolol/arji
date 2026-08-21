-- Give an uploaded file an owner, so it can eventually be deleted.
--
-- `chat_attachments` had exactly one relation: `chat_message_id`, set when a
-- chat message is sent. A bug screenshot never gets one — the modal uploads
-- first and the bug then stores the *path* in `epics.images`, a free-form JSON
-- column with no foreign key. So the row and its bytes had no owner at all:
-- removing a thumbnail, abandoning the form, deleting the bug or deleting the
-- whole project each left them on disk permanently.
--
-- `project_id` is the owner every upload has from the moment it is written —
-- `POST /chat/upload` already knows it, it was simply never recorded.
-- `epic_id` is the owner a screenshot gains when a bug is filed with it, and
-- what makes `NULL, NULL` mean "staged, claimed by nobody" — the one state a
-- discard is allowed to delete.
--
-- Both cascade, so the rows go with their owner; the bytes are removed by
-- lib/uploads/attachment-ownership.ts, which reads the paths before the delete
-- and unlinks them after it commits.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS, so like 0023/0024/0026/0028 this is
-- not an idempotent no-op, and re-running it on a database that already has
-- the columns throws. A database can reach that state by losing its drizzle
-- bookkeeping, so both columns are listed in POST_BASELINE_COLUMN_MIGRATIONS
-- (lib/db/init.ts), which stamps this migration as applied when they exist.
ALTER TABLE chat_attachments ADD COLUMN project_id text REFERENCES projects(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE chat_attachments ADD COLUMN epic_id text REFERENCES epics(id) ON DELETE cascade;--> statement-breakpoint
-- Backfill the project from the path the upload route has always written:
-- `data/uploads/<project_id>/<file>`. Compared with substr() rather than LIKE
-- because a project id may contain `_`, which LIKE reads as a wildcard — that
-- would let one project claim another's uploads.
UPDATE chat_attachments SET project_id = (
  SELECT p.id FROM projects p
  WHERE substr(chat_attachments.file_path, 1, length(p.id) + 14)
      = 'data/uploads/' || p.id || '/'
) WHERE project_id IS NULL;--> statement-breakpoint
-- Backfill the ticket for screenshots already attached to a bug, so tickets
-- filed before this migration clean up like the ones filed after it.
-- `epics.images` is untrusted text: json_each() is fed '[]' whenever the column
-- does not hold valid JSON, so a malformed value yields no match instead of
-- aborting the migration.
UPDATE chat_attachments SET epic_id = (
  SELECT e.id FROM epics e,
    json_each(CASE WHEN json_valid(e.images) THEN e.images ELSE '[]' END) AS image
  WHERE image.value = chat_attachments.file_path
  LIMIT 1
) WHERE epic_id IS NULL;
