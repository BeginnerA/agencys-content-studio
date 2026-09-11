CREATE TABLE `api_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_key` text NOT NULL,
	`service_type` text NOT NULL,
	`credential_id` integer,
	`name` text NOT NULL,
	`base_url` text,
	`api_key_ref` text DEFAULT 'local' NOT NULL,
	`model` text,
	`extra` text DEFAULT '{}' NOT NULL,
	`pricing` text DEFAULT '{}' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_configs_type_default` ON `api_configs` (`service_type`,`is_default`);--> statement-breakpoint
CREATE INDEX `idx_configs_credential` ON `api_configs` (`credential_id`);--> statement-breakpoint
CREATE TABLE `api_providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`service_type` text NOT NULL,
	`vendor` text,
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
	`run_id` integer,
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
CREATE TABLE `characters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`name` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`summary` text,
	`appearance` text,
	`negative` text,
	`voice` text,
	`ref_asset_ids` text DEFAULT '[]' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_characters_project` ON `characters` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_characters_name` ON `characters` (`name`);--> statement-breakpoint
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
CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`type` text DEFAULT 'note' NOT NULL,
	`name` text,
	`content` text NOT NULL,
	`embedding` text,
	`embedding_model` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memories_project` ON `memories` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_name` ON `memories` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`template_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`current_step_key` text,
	`input` text NOT NULL,
	`template_snapshot` text,
	`summary` text,
	`error` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`batch_id` integer,
	`batch_seq` integer
);
--> statement-breakpoint
CREATE INDEX `idx_runs_project` ON `pipeline_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_runs_status` ON `pipeline_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_runs_batch` ON `pipeline_runs` (`batch_id`);--> statement-breakpoint
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
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_key_unique` ON `settings` (`key`);--> statement-breakpoint
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
CREATE TABLE `vendor_credentials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor` text NOT NULL,
	`name` text NOT NULL,
	`api_key_ref` text DEFAULT 'local' NOT NULL,
	`base_url` text,
	`extra` text DEFAULT '{}' NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_credentials_vendor_unique` ON `vendor_credentials` (`vendor`);