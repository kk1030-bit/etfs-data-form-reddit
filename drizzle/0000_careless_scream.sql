CREATE TABLE `author_metrics` (
	`author` text PRIMARY KEY NOT NULL,
	`influence_score` real DEFAULT 0.5 NOT NULL,
	`observed_posts` integer DEFAULT 0 NOT NULL,
	`top_hit_rate` real DEFAULT 0 NOT NULL,
	`subreddit_count` integer DEFAULT 0 NOT NULL,
	`computed_at_utc` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_reports` (
	`report_date` text PRIMARY KEY NOT NULL,
	`period_start_utc` text NOT NULL,
	`period_end_utc` text NOT NULL,
	`generated_at_utc` text NOT NULL,
	`headline` text NOT NULL,
	`executive_summary` text NOT NULL,
	`sections_json` text NOT NULL,
	`coverage_success` integer NOT NULL,
	`coverage_expected` integer DEFAULT 24 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `hourly_rankings` (
	`logical_hour_utc` text NOT NULL,
	`rank` integer NOT NULL,
	`post_id` text NOT NULL,
	`heat_score` real NOT NULL,
	`components_json` text NOT NULL,
	`previous_rank` integer,
	PRIMARY KEY(`logical_hour_utc`, `rank`),
	FOREIGN KEY (`logical_hour_utc`) REFERENCES `hourly_runs`(`logical_hour_utc`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `reddit_posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_hourly_rankings_hour_post` ON `hourly_rankings` (`logical_hour_utc`,`post_id`);--> statement-breakpoint
CREATE INDEX `idx_hourly_rankings_post` ON `hourly_rankings` (`post_id`);--> statement-breakpoint
CREATE TABLE `hourly_runs` (
	`logical_hour_utc` text PRIMARY KEY NOT NULL,
	`started_at_utc` text NOT NULL,
	`completed_at_utc` text,
	`status` text NOT NULL,
	`candidate_count` integer DEFAULT 0 NOT NULL,
	`selected_count` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`logical_time_utc` text NOT NULL,
	`started_at_utc` text NOT NULL,
	`completed_at_utc` text,
	`status` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_job_runs_type_time` ON `job_runs` (`job_type`,`logical_time_utc`);--> statement-breakpoint
CREATE INDEX `idx_job_runs_status` ON `job_runs` (`status`,`started_at_utc`);--> statement-breakpoint
CREATE TABLE `post_observations` (
	`post_id` text NOT NULL,
	`observed_hour_utc` text NOT NULL,
	`observed_at_utc` text NOT NULL,
	`score` integer NOT NULL,
	`comments` integer NOT NULL,
	`upvote_ratio` real NOT NULL,
	`best_listing_rank` integer,
	`velocity_score` real NOT NULL,
	`heat_score` real NOT NULL,
	PRIMARY KEY(`post_id`, `observed_hour_utc`),
	FOREIGN KEY (`post_id`) REFERENCES `reddit_posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_post_observations_hour` ON `post_observations` (`observed_hour_utc`);--> statement-breakpoint
CREATE TABLE `reddit_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`reddit_id` text NOT NULL,
	`subreddit` text NOT NULL,
	`author` text,
	`permalink` text NOT NULL,
	`outbound_url` text,
	`title_original` text NOT NULL,
	`body_original` text DEFAULT '' NOT NULL,
	`title_zh` text,
	`translation_zh` text,
	`summary_zh` text,
	`highlights_json` text DEFAULT '[]' NOT NULL,
	`topics_json` text DEFAULT '[]' NOT NULL,
	`content_hash` text NOT NULL,
	`analysis_status` text DEFAULT 'pending' NOT NULL,
	`source_platform` text DEFAULT 'reddit' NOT NULL,
	`created_at_utc` text NOT NULL,
	`first_seen_at_utc` text NOT NULL,
	`last_seen_at_utc` text NOT NULL,
	`deleted_at_utc` text,
	CONSTRAINT "chk_reddit_posts_source" CHECK("reddit_posts"."source_platform" = 'reddit')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_reddit_posts_reddit_id` ON `reddit_posts` (`reddit_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_reddit_posts_permalink` ON `reddit_posts` (`permalink`);--> statement-breakpoint
CREATE INDEX `idx_reddit_posts_last_seen` ON `reddit_posts` (`last_seen_at_utc`);--> statement-breakpoint
CREATE INDEX `idx_reddit_posts_author` ON `reddit_posts` (`author`);--> statement-breakpoint
CREATE TABLE `tracking_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`started_at_utc` text NOT NULL,
	`expires_at_utc` text NOT NULL,
	`last_selected_at_utc` text NOT NULL,
	`selected_count` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `reddit_posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tracking_episodes_status_expires` ON `tracking_episodes` (`status`,`expires_at_utc`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_tracking_episodes_post_start` ON `tracking_episodes` (`post_id`,`started_at_utc`);--> statement-breakpoint
CREATE TABLE `weekly_reports` (
	`week_start_date` text PRIMARY KEY NOT NULL,
	`period_start_utc` text NOT NULL,
	`period_end_utc` text NOT NULL,
	`generated_at_utc` text NOT NULL,
	`headline` text NOT NULL,
	`executive_summary` text NOT NULL,
	`sections_json` text NOT NULL,
	`days_included` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
