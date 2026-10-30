CREATE TABLE `content_continuity_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` integer NOT NULL,
	`unit_kind` text NOT NULL,
	`unit_id` integer NOT NULL,
	`unit_ordinal` integer NOT NULL,
	`row_type` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`document_asset_id` integer,
	`document_version_id` integer,
	`document_hash` text,
	`source_run_id` integer,
	`source_step_id` integer,
	`source_asset_id` integer,
	`source_version_id` integer,
	`source_hash` text,
	`run_id` integer,
	`step_id` integer,
	`parent_id` integer,
	`operation_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`approval_key` text,
	`approval_hash` text,
	`replaced_by_id` integer,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`confirmed_at` integer,
	CONSTRAINT "ck_continuity_row_status" CHECK((
    ("content_continuity_records"."row_type" = 'entry' AND "content_continuity_records"."status" IN ('extracting','draft','failed','unknown','confirmed','superseded')) OR
    ("content_continuity_records"."row_type" = 'context' AND "content_continuity_records"."status" IN ('frozen','bound')) OR
    ("content_continuity_records"."row_type" = 'consumption' AND "content_continuity_records"."status" IN ('prepared','dispatching','completed','failed','unknown'))
  )),
	CONSTRAINT "ck_continuity_document" CHECK((
    ("content_continuity_records"."document_asset_id" IS NOT NULL AND "content_continuity_records"."document_version_id" IS NOT NULL AND "content_continuity_records"."document_hash" IS NOT NULL) OR
    ("content_continuity_records"."document_asset_id" IS NULL AND "content_continuity_records"."document_version_id" IS NULL AND "content_continuity_records"."document_hash" IS NULL
      AND "content_continuity_records"."row_type" = 'entry' AND "content_continuity_records"."status" IN ('extracting','failed','unknown'))
  )),
	CONSTRAINT "ck_continuity_unit" CHECK("content_continuity_records"."scope_kind" = 'series' AND "content_continuity_records"."unit_kind" = 'episode'
    AND "content_continuity_records"."project_id" > 0 AND "content_continuity_records"."scope_id" > 0 AND "content_continuity_records"."unit_id" > 0 AND "content_continuity_records"."unit_ordinal" > 0 AND "content_continuity_records"."revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_continuity_operation` ON `content_continuity_records` (`project_id`,`row_type`,`operation_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_continuity_confirmed_unit` ON `content_continuity_records` (`project_id`,`scope_kind`,`scope_id`,`unit_kind`,`unit_id`) WHERE "content_continuity_records"."row_type" = 'entry' AND "content_continuity_records"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX `idx_continuity_source` ON `content_continuity_records` (`source_run_id`,`source_step_id`,`source_asset_id`,`source_version_id`);--> statement-breakpoint
CREATE INDEX `idx_continuity_parent` ON `content_continuity_records` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_continuity_run` ON `content_continuity_records` (`run_id`,`step_id`);