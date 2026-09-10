CREATE TABLE `batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`template_key` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`schedule` text DEFAULT '{"max_concurrent":1}' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`finished` integer DEFAULT 0 NOT NULL,
	`succeeded` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_batches_project` ON `batches` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_batches_status` ON `batches` (`status`);--> statement-breakpoint
CREATE TABLE `publications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`run_id` integer,
	`asset_id` integer,
	`platform` text NOT NULL,
	`url` text,
	`published_at` integer,
	`metrics` text DEFAULT '{}' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_publications_project` ON `publications` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_publications_asset` ON `publications` (`asset_id`);--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`run_id` integer,
	`step_id` integer,
	`task_id` integer,
	`asset_id` integer,
	`kind` text NOT NULL,
	`provider` text,
	`model` text,
	`quantity` real NOT NULL,
	`unit` text NOT NULL,
	`unit_price` real,
	`cost` real,
	`currency` text DEFAULT 'CNY' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_project` ON `usage_records` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_run` ON `usage_records` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_kind` ON `usage_records` (`kind`);--> statement-breakpoint
ALTER TABLE `assets` ADD `run_id` integer;--> statement-breakpoint
ALTER TABLE `pipeline_runs` ADD `batch_id` integer;--> statement-breakpoint
ALTER TABLE `pipeline_runs` ADD `batch_seq` integer;--> statement-breakpoint
CREATE INDEX `idx_runs_batch` ON `pipeline_runs` (`batch_id`);