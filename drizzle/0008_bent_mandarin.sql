ALTER TABLE `post_observations` ADD `indexed_comment_count` integer;--> statement-breakpoint
ALTER TABLE `post_observations` ADD `comment_count_at_utc` text;--> statement-breakpoint
ALTER TABLE `post_observations` ADD `comment_delta` integer;--> statement-breakpoint
ALTER TABLE `post_observations` ADD `comment_interval_hours` real;--> statement-breakpoint
ALTER TABLE `reddit_posts` ADD `link_flair_text` text;