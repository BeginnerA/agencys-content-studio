CREATE TABLE `review_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`step_key` text DEFAULT 'compose' NOT NULL,
	`base_final_asset_id` integer NOT NULL,
	`client_key` text,
	`scope_kind` text NOT NULL,
	`shot_id` text,
	`start_ms` integer,
	`end_ms` integer,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`note` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`rework_request_id` text,
	`rework_note` text,
	`base_snapshot` text DEFAULT '{}' NOT NULL,
	`recheck_state` text,
	`recheck_final_asset_id` integer,
	`recheck_note` text,
	`recheck_at` integer,
	`resolution_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_findings_run_client` ON `review_findings` (`run_id`,`client_key`);--> statement-breakpoint
CREATE INDEX `idx_findings_run_status` ON `review_findings` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_findings_project` ON `review_findings` (`project_id`);