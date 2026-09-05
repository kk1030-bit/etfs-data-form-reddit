CREATE TABLE `title_index_runs` (
	`logical_hour_utc` text PRIMARY KEY NOT NULL,
	`checked_at_utc` text NOT NULL,
	`status` text NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`items_json` text DEFAULT '[]' NOT NULL,
	`error` text
);
