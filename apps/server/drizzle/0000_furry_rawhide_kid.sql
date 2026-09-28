CREATE TABLE IF NOT EXISTS `api_configs` (
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
CREATE INDEX IF NOT EXISTS `idx_configs_type_default` ON `api_configs` (`service_type`,`is_default`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_configs_credential` ON `api_configs` (`credential_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `api_providers` (
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
CREATE UNIQUE INDEX IF NOT EXISTS `api_providers_key_unique` ON `api_providers` (`key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `assets` (
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
	`deleted_at` integer,
	`embedding` text,
	`embedding_model` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_assets_project_purpose` ON `assets` (`project_id`,`purpose`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_assets_project_kind` ON `assets` (`project_id`,`kind`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `batches` (
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
CREATE INDEX IF NOT EXISTS `idx_batches_project` ON `batches` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_batches_status` ON `batches` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `budget_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`scope_id` integer,
	`kind` text NOT NULL,
	`budget` real NOT NULL,
	`spent` real NOT NULL,
	`ratio` real NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_budget_alerts_scope` ON `budget_alerts` (`scope`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `canvas_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canvas_id` integer NOT NULL,
	`from` integer NOT NULL,
	`to` integer NOT NULL,
	`port` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_canvas_edges_unique` ON `canvas_edges` (`canvas_id`,`from`,`to`,`port`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_edges_canvas` ON `canvas_edges` (`canvas_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `canvas_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canvas_id` integer NOT NULL,
	`title` text DEFAULT '未命名分组' NOT NULL,
	`color` text,
	`collapsed` integer DEFAULT 0 NOT NULL,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	`parent_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_groups_canvas` ON `canvas_groups` (`canvas_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `canvas_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canvas_id` integer NOT NULL,
	`kind` text NOT NULL,
	`asset_id` integer,
	`title` text,
	`spec` text,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	`adopted_task_id` integer,
	`seq` integer,
	`group_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_nodes_canvas` ON `canvas_nodes` (`canvas_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `canvas_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canvas_id` integer NOT NULL,
	`label` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_snapshots_canvas` ON `canvas_snapshots` (`canvas_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `canvases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text DEFAULT '未命名画布' NOT NULL,
	`viewport` text DEFAULT '{"x":0,"y":0,"zoom":1}' NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvases_project` ON `canvases` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `characters` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`kind` text DEFAULT 'character' NOT NULL,
	`name` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`summary` text,
	`appearance` text,
	`negative` text,
	`voice` text,
	`voice_desc` text,
	`states` text DEFAULT '[]' NOT NULL,
	`ref_asset_ids` text DEFAULT '[]' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_characters_project` ON `characters` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_characters_name` ON `characters` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `content_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`obj_kind` text NOT NULL,
	`obj_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`payload_kind` text DEFAULT 'file' NOT NULL,
	`rel_path` text,
	`sha256` text,
	`doc` text,
	`label` text,
	`source` text DEFAULT 'edit' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_cv_obj_rev` ON `content_versions` (`obj_kind`,`obj_id`,`revision`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cv_project` ON `content_versions` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `creation_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`payload` text,
	`request_key` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_creation_messages_session` ON `creation_messages` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_creation_message_request` ON `creation_messages` (`session_id`,`request_key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `creation_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`request_key` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`plan` text,
	`approved_plan` text,
	`plan_revision` integer DEFAULT 0 NOT NULL,
	`plan_hash` text,
	`preflight` text,
	`start_key` text,
	`run_id` integer,
	`run_history` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_creation_request` ON `creation_sessions` (`request_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_creation_project` ON `creation_sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_creation_run` ON `creation_sessions` (`run_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`series_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text,
	`status` text DEFAULT 'locked' NOT NULL,
	`content_asset_id` integer,
	`latest_run_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_episodes_project_number` ON `episodes` (`project_id`,`number`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_episodes_series` ON `episodes` (`series_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `exec_inputs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`role` text NOT NULL,
	`src_kind` text NOT NULL,
	`src_id` integer NOT NULL,
	`version_id` integer,
	`used` integer DEFAULT 1 NOT NULL,
	`skip_reason` text,
	`shot_id` text,
	`port` text,
	`ordinal` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ei_snapshot` ON `exec_inputs` (`snapshot_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ei_source` ON `exec_inputs` (`src_kind`,`src_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `exec_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`exec_kind` text NOT NULL,
	`run_id` integer,
	`step_id` integer,
	`task_id` integer,
	`template_key` text,
	`model` text,
	`input_hash` text,
	`frozen_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_es_project` ON `exec_snapshots` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_es_task` ON `exec_snapshots` (`task_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_es_step` ON `exec_snapshots` (`step_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `gen_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`run_id` integer,
	`step_id` integer,
	`canvas_node_id` integer,
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
CREATE INDEX IF NOT EXISTS `idx_tasks_status` ON `gen_tasks` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_run` ON `gen_tasks` (`run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_project` ON `gen_tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `memories` (
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
CREATE INDEX IF NOT EXISTS `idx_memories_project` ON `memories` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_memories_name` ON `memories` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pipeline_runs` (
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
	`batch_seq` integer,
	`workflow_id` integer,
	`workflow_seq` integer,
	`resumed_from_run_id` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_project` ON `pipeline_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_status` ON `pipeline_runs` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_batch` ON `pipeline_runs` (`batch_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_workflow` ON `pipeline_runs` (`workflow_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pipeline_steps` (
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
CREATE INDEX IF NOT EXISTS `idx_steps_run` ON `pipeline_steps` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `projects` (
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
CREATE INDEX IF NOT EXISTS `idx_projects_status` ON `projects` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `publications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`run_id` integer,
	`asset_id` integer,
	`platform` text NOT NULL,
	`url` text,
	`published_at` integer,
	`metrics` text DEFAULT '{}' NOT NULL,
	`title` text,
	`ab_group` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_publications_project` ON `publications` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_publications_asset` ON `publications` (`asset_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rework_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`step_key` text NOT NULL,
	`session_id` integer,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`state` text DEFAULT 'parsing' NOT NULL,
	`base_fingerprint` text,
	`changes_json` text DEFAULT '[]' NOT NULL,
	`preview_json` text DEFAULT '{}' NOT NULL,
	`result_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_rework_requests_run_key` ON `rework_requests` (`run_id`,`request_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rework_requests_project` ON `rework_requests` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rework_requests_run` ON `rework_requests` (`run_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`template_key` text NOT NULL,
	`cron_expr` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_triggered_at` integer,
	`last_batch_id` integer,
	`input_template` text DEFAULT '{}' NOT NULL,
	`note` text,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_schedules_project` ON `schedules` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_schedules_status` ON `schedules` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_schedules_scheduled` ON `schedules` (`scheduled_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`total_episodes` integer DEFAULT 0 NOT NULL,
	`content_asset_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_series_project` ON `series` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `settings_key_unique` ON `settings` (`key`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `style_presets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`snippet` text NOT NULL,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `style_presets_name_unique` ON `style_presets` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `usage_records` (
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
CREATE INDEX IF NOT EXISTS `idx_usage_project` ON `usage_records` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_usage_run` ON `usage_records` (`run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_usage_kind` ON `usage_records` (`kind`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vendor_credentials` (
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
CREATE UNIQUE INDEX IF NOT EXISTS `vendor_credentials_vendor_unique` ON `vendor_credentials` (`vendor`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `voice_clones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider_key` text NOT NULL,
	`model` text NOT NULL,
	`voice_id` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `voice_clones_name_unique` ON `voice_clones` (`name`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workflows` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`auto_advance` integer DEFAULT 0 NOT NULL,
	`budget_cap` real,
	`segments` text DEFAULT '[]' NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflows_project` ON `workflows` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflows_status` ON `workflows` (`status`);