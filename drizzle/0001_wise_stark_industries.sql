CREATE TABLE `author_observations` (
	`author` text NOT NULL,
	`post_id` text NOT NULL,
	`first_seen_at_utc` text NOT NULL,
	`subreddit` text NOT NULL,
	`peak_heat_score` real NOT NULL,
	`is_top_hit` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`author`, `post_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_author_observations_first_seen` ON `author_observations` (`first_seen_at_utc`);--> statement-breakpoint
CREATE INDEX `idx_author_observations_author` ON `author_observations` (`author`);