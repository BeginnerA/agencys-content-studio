CREATE TABLE `quality_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`episode_idx` integer NOT NULL,
	`citation_score` real NOT NULL,
	`consistency_score` real NOT NULL,
	`coherence_score` real NOT NULL,
	`cost_score` real NOT NULL,
	`overall_score` real NOT NULL,
	`weights` text NOT NULL,
	`metadata` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_quality_scores_run` ON `quality_scores` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_quality_scores_run_episode` ON `quality_scores` (`run_id`,`episode_idx`);--> statement-breakpoint
CREATE TABLE `role_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role_key` text NOT NULL,
	`persona_file` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_configs_role_key_unique` ON `role_configs` (`role_key`);