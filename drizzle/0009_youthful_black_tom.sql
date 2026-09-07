CREATE TABLE `deep_analysis_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`published_at_utc` text NOT NULL,
	`first_seen_at_utc` text NOT NULL,
	`score` real NOT NULL,
	`card_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deep_articles_published_score` ON `deep_analysis_articles` (`published_at_utc`,`score`);--> statement-breakpoint
CREATE TABLE `deep_analysis_authors` (
	`author` text PRIMARY KEY NOT NULL,
	`long_posts` integer NOT NULL,
	`checked_at_utc` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deep_authors_checked` ON `deep_analysis_authors` (`checked_at_utc`);--> statement-breakpoint
CREATE TABLE `deep_analysis_runs` (
	`day` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`status` text NOT NULL,
	`started_at_utc` text NOT NULL,
	`completed_at_utc` text,
	`requests` integer DEFAULT 0 NOT NULL,
	`accepted` integer DEFAULT 0 NOT NULL,
	`rejected` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "chk_deep_requests" CHECK("deep_analysis_runs"."requests" >= 0 AND "deep_analysis_runs"."requests" <= 25)
);
--> statement-breakpoint
CREATE TABLE `deep_analysis_seen` (
	`id` text PRIMARY KEY NOT NULL,
	`seen_at_utc` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deep_seen_at` ON `deep_analysis_seen` (`seen_at_utc`);