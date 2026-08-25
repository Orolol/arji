-- Only one dispatcher of a given kind may exist per project. Keep the most
-- recently inserted row if a development database already contains duplicates.
DELETE FROM `routines`
WHERE `rowid` NOT IN (
	SELECT MAX(`rowid`)
	FROM `routines`
	GROUP BY `project_id`, `kind`
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `routines_project_kind_unique`
ON `routines` (`project_id`, `kind`);
