CREATE TABLE `deep_analysis_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`subreddit` text NOT NULL,
	`characters` integer NOT NULL,
	`score` real NOT NULL,
	`published_at_utc` text NOT NULL,
	`status` text NOT NULL,
	`rubric_version` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deep_candidates_window_score` ON `deep_analysis_candidates` (`published_at_utc`,`score`);--> statement-breakpoint
CREATE TABLE `deep_calibration_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `deep_analysis_seen` ADD `rubric_version` text DEFAULT 'legacy' NOT NULL;