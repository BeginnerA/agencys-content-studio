CREATE TABLE `character_consistency_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`entity_id` integer NOT NULL,
	`episode_idx` integer DEFAULT 0 NOT NULL,
	`score` real,
	`asset_total` integer DEFAULT 0 NOT NULL,
	`asset_sampled` integer DEFAULT 0 NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`model` text,
	`provider` text,
	`note` text,
	`evaluated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_char_consistency_pair` ON `character_consistency_results` (`run_id`,`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_char_consistency_run` ON `character_consistency_results` (`run_id`);--> statement-breakpoint
CREATE TABLE `entity_references` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_id` integer NOT NULL,
	`asset_id` integer NOT NULL,
	`role` text NOT NULL,
	`state_key` text,
	`view_key` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_entity_refs_pair` ON `entity_references` (`entity_id`,`asset_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_refs_entity` ON `entity_references` (`entity_id`);--> statement-breakpoint
ALTER TABLE `style_presets` ADD `negative` text;