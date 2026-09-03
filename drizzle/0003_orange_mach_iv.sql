CREATE TABLE `reddit_source_state` (
	`source` text PRIMARY KEY NOT NULL,
	`consecutive_429` integer DEFAULT 0 NOT NULL,
	`cooldown_until_utc` text,
	`last_attempt_at_utc` text,
	`last_error` text,
	`lease_token` text,
	`lease_until_utc` text
);
--> statement-breakpoint
ALTER TABLE `hourly_runs` ADD `stage` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `hourly_runs` ADD `upstream_status` integer;--> statement-breakpoint
ALTER TABLE `hourly_runs` ADD `retry_at_utc` text;