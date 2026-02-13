ALTER TABLE `documents` ADD `original_filename` text;
--> statement-breakpoint
ALTER TABLE `documents` ADD `kind` text NOT NULL DEFAULT 'text';
--> statement-breakpoint
ALTER TABLE `documents` ADD `markdown_content` text;
--> statement-breakpoint
ALTER TABLE `documents` ADD `image_path` text;
--> statement-breakpoint
ALTER TABLE `documents` ADD `size_bytes` integer;
--> statement-breakpoint
ALTER TABLE `documents` ADD `updated_at` text DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint

UPDATE `documents`
SET
  `original_filename` = COALESCE(`original_filename`, `name`),
  `markdown_content` = COALESCE(`markdown_content`, `content_md`),
  `size_bytes` = COALESCE(`size_bytes`, 0),
  `kind` = CASE
    WHEN `kind` IS NULL OR TRIM(`kind`) = '' THEN 'text'
    ELSE `kind`
  END,
  `updated_at` = COALESCE(`updated_at`, `created_at`, CURRENT_TIMESTAMP);
--> statement-breakpoint

DELETE FROM `documents`
WHERE `id` IN (
  SELECT d1.`id`
  FROM `documents` d1
  JOIN `documents` d2
    ON d1.`project_id` = d2.`project_id`
   AND LOWER(COALESCE(d1.`original_filename`, d1.`name`)) = LOWER(COALESCE(d2.`original_filename`, d2.`name`))
   AND d1.`id` > d2.`id`
);
--> statement-breakpoint

CREATE UNIQUE INDEX `documents_project_filename_ci_unique`
ON `documents` (`project_id`, LOWER(`original_filename`));
--> statement-breakpoint

CREATE INDEX `documents_project_created_at_idx`
ON `documents` (`project_id`, `created_at`);
