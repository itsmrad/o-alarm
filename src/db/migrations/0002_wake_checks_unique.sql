-- Keep one Wake Check row per occurrence (the newest insert) before enforcing it.
DELETE FROM `wake_checks` WHERE `rowid` NOT IN (SELECT max(`rowid`) FROM `wake_checks` GROUP BY `occurrence_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `wake_checks_occurrence_idx` ON `wake_checks` (`occurrence_key`);