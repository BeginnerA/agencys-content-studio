CREATE TABLE `repair_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_run_id` integer NOT NULL,
	`episode_idx` integer NOT NULL,
	`status` text NOT NULL,
	`issues` text NOT NULL,
	`impact_scope` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`total_cost` real DEFAULT 0 NOT NULL,
	`score_before` real,
	`score_after` real,
	`stop_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_repair_runs_source` ON `repair_runs` (`source_run_id`);--> statement-breakpoint
CREATE INDEX `idx_repair_runs_status` ON `repair_runs` (`status`);