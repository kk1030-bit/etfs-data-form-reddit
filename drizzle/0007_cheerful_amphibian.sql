CREATE TABLE `scheduler_checks` (
	`logical_hour_utc` text PRIMARY KEY NOT NULL,
	`checked_at_utc` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_dispatch_at_utc` text,
	`next_check_at_utc` text,
	`error` text,
	`lease_token` text,
	`lease_until_utc` text,
	CONSTRAINT "chk_scheduler_attempts" CHECK("scheduler_checks"."attempts" >= 0 AND "scheduler_checks"."attempts" <= 2)
);
