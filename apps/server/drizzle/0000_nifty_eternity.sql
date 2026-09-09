CREATE TABLE `api_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_key` text NOT NULL,
	`service_type` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`api_key_ref` text DEFAULT 'local' NOT NULL,
	`model` text,
	`extra` text DEFAULT '{}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_configs_type_default` ON `api_configs` (`service_type`,`is_default`);--> statement-breakpoint
CREATE TABLE `api_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`service_type` text NOT NULL,
	`default_url` text,
	`preset_models` text,
	`description` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_providers_key_unique` ON `api_providers` (`key`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`step_id` integer,
	`task_id` integer,
	`kind` text NOT NULL,
	`purpose` text,
	`name` text NOT NULL,
	`mime` text,
	`ext` text,
	`file_size` integer,
	`width` integer,
	`height` integer,
	`duration` integer,
	`sha256` text,
	`rel_path` text,
	`prompt` text,
	`params` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`is_favorite` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_assets_project_purpose` ON `assets` (`project_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `idx_assets_project_kind` ON `assets` (`project_id`,`kind`);--> statement-breakpoint
CREATE TABLE `gen_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`run_id` integer,
	`step_id` integer,
	`kind` text NOT NULL,
	`provider` text,
	`model` text,
	`prompt` text,
	`params` text NOT NULL,
	`task_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_msg` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`result_asset_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `gen_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_run` ON `gen_tasks` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_project` ON `gen_tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`template_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`current_step_key` text,
	`input` text NOT NULL,
	`summary` text,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runs_project` ON `pipeline_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_status` ON `pipeline_runs` (`status`);--> statement-breakpoint
CREATE TABLE `pipeline_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`step_key` text NOT NULL,
	`action_key` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`input` text,
	`output` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_steps_run` ON `pipeline_steps` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`genre` text DEFAULT 'drama_short' NOT NULL,
	`brief` text,
	`template_key` text DEFAULT 'mengbao-episode' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`cover_asset_id` integer,
	`settings` text DEFAULT '{}' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_projects_status` ON `projects` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_key_unique` ON `settings` (`key`);