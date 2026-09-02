ALTER TABLE `hourly_runs` ADD `source_mode` text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE `post_observations` ADD `metrics_available` integer DEFAULT true NOT NULL;