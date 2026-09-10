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
CREATE INDEX `idx_memories_name` ON `memories` (`project_id`,`name`);