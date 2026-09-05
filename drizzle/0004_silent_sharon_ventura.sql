CREATE TABLE `ai_daily_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `hourly_runs` ADD `source_details_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `post_observations` ADD `discussion_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reddit_posts` ADD `source_provider` text DEFAULT 'reddit' NOT NULL;--> statement-breakpoint
ALTER TABLE `reddit_posts` ADD `indexed_at_utc` text;