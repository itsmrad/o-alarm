CREATE TABLE `alarm_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`alarm_id` text NOT NULL,
	`occurrence_key` text NOT NULL,
	`expected_at` text NOT NULL,
	`status` text NOT NULL,
	`triggered_at` text,
	`dismissed_at` text,
	`snooze_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alarm_occurrences_key_idx` ON `alarm_occurrences` (`occurrence_key`);--> statement-breakpoint
CREATE INDEX `alarm_occurrences_alarm_idx` ON `alarm_occurrences` (`alarm_id`);--> statement-breakpoint
CREATE TABLE `alarms` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`hour` integer NOT NULL,
	`minute` integer NOT NULL,
	`weekdays` text NOT NULL,
	`date` text,
	`timezone_policy` text NOT NULL,
	`time_zone` text,
	`label` text DEFAULT '' NOT NULL,
	`enabled` integer NOT NULL,
	`sound` text NOT NULL,
	`vibration` integer NOT NULL,
	`escalation` text NOT NULL,
	`snooze` text NOT NULL,
	`skip_next` text,
	`one_off_override` text,
	`missions` text NOT NULL,
	`wake_check` text NOT NULL,
	`important` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`alarm_id` text,
	`occurrence_key` text,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_occurred_at_idx` ON `events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE INDEX `events_alarm_idx` ON `events` (`alarm_id`);--> statement-breakpoint
CREATE TABLE `mission_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`wake_session_id` text NOT NULL,
	`mission_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`outcome` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`details` text
);
--> statement-breakpoint
CREATE INDEX `mission_attempts_session_idx` ON `mission_attempts` (`wake_session_id`);--> statement-breakpoint
CREATE TABLE `morning_checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`date` text NOT NULL,
	`energy` integer,
	`sleep_quality` integer,
	`wake_session_id` text
);
--> statement-breakpoint
CREATE INDEX `morning_checkins_date_idx` ON `morning_checkins` (`date`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`op` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` text
);
--> statement-breakpoint
CREATE INDEX `outbox_created_at_idx` ON `outbox` (`created_at`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `preferences_key_idx` ON `preferences` (`key`);--> statement-breakpoint
CREATE TABLE `sleep_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_state` (
	`entity` text PRIMARY KEY NOT NULL,
	`last_pulled_at` text,
	`cursor` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wake_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`wake_session_id` text NOT NULL,
	`occurrence_key` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`state` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wake_checks_session_idx` ON `wake_checks` (`wake_session_id`);--> statement-breakpoint
CREATE TABLE `wake_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`deleted_at` text,
	`device_id` text NOT NULL,
	`alarm_id` text NOT NULL,
	`occurrence_key` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`outcome` text,
	`snooze_count` integer DEFAULT 0 NOT NULL,
	`dismiss_method` text
);
--> statement-breakpoint
CREATE INDEX `wake_sessions_occurrence_idx` ON `wake_sessions` (`occurrence_key`);