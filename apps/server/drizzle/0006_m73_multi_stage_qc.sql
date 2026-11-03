CREATE TABLE `quality_gates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`episode_idx` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`blocking_count` integer DEFAULT 0 NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`exempt_count` integer DEFAULT 0 NOT NULL,
	`checked_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_quality_gates_run` ON `quality_gates` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_quality_gates_unique` ON `quality_gates` (`run_id`,`episode_idx`,`stage`);--> statement-breakpoint
CREATE TABLE `quality_issues` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`episode_idx` integer NOT NULL,
	`stage` text NOT NULL,
	`checker` text NOT NULL,
	`dimension` text NOT NULL,
	`severity` text NOT NULL,
	`check_type` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`evidence` text NOT NULL,
	`suggestion` text,
	`exempted` integer DEFAULT 0 NOT NULL,
	`exempted_by` text,
	`exempted_at` integer,
	`exempt_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_quality_issues_run` ON `quality_issues` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_quality_issues_stage` ON `quality_issues` (`run_id`,`stage`);--> statement-breakpoint
CREATE INDEX `idx_quality_issues_severity` ON `quality_issues` (`run_id`,`severity`);