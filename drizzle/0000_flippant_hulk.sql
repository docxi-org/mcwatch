CREATE TABLE `crawl_state` (
	`date` text PRIMARY KEY NOT NULL,
	`phase` text DEFAULT 'landing' NOT NULL,
	`next_page` integer DEFAULT 1 NOT NULL,
	`processed_slugs` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`worker` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `events_log_ts_idx` ON `events_log` (`ts`);--> statement-breakpoint
CREATE TABLE `game_platforms` (
	`game_slug` text NOT NULL,
	`platform` text NOT NULL,
	`metascore` integer,
	`userscore` real,
	`critic_count` integer,
	`user_count` integer,
	PRIMARY KEY(`game_slug`, `platform`),
	FOREIGN KEY (`game_slug`) REFERENCES `games`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_platforms_platform_idx` ON `game_platforms` (`platform`);--> statement-breakpoint
CREATE TABLE `games` (
	`slug` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`cover_url` text,
	`video_url` text,
	`developer` text,
	`publisher` text,
	`genres` text,
	`description` text,
	`release_date` text,
	`esrb` text,
	`description_hash` text,
	`embedding` blob,
	`first_seen` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_crawled` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `games_last_crawled_idx` ON `games` (`last_crawled`);--> statement-breakpoint
CREATE INDEX `games_title_idx` ON `games` (`title`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `jobs_status_type_idx` ON `jobs` (`status`,`type`);--> statement-breakpoint
CREATE TABLE `letsplays` (
	`game_slug` text PRIMARY KEY NOT NULL,
	`video_id` text,
	`title` text,
	`channel` text,
	`views` integer,
	`duration_s` integer,
	`transcript_source` text,
	`conclusion` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_error` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`game_slug`) REFERENCES `games`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_slug` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`score` real,
	`score_max` integer NOT NULL,
	`author` text,
	`platform` text,
	`date` text,
	`text` text NOT NULL,
	`sentiment` text,
	`url` text,
	FOREIGN KEY (`game_slug`) REFERENCES `games`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reviews_game_kind_idx` ON `reviews` (`game_slug`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_external_uq` ON `reviews` (`game_slug`,`kind`,`external_id`);--> statement-breakpoint
CREATE TABLE `summaries` (
	`game_slug` text NOT NULL,
	`kind` text NOT NULL,
	`likes` text NOT NULL,
	`dislikes` text NOT NULL,
	`summary` text NOT NULL,
	`model` text NOT NULL,
	`review_count_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`game_slug`, `kind`),
	FOREIGN KEY (`game_slug`) REFERENCES `games`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `worker_status` (
	`worker` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`current_item` text,
	`processed_total` integer DEFAULT 0 NOT NULL,
	`failed_total` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_error` text
);
