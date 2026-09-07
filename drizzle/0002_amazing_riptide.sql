CREATE TABLE `letsplay_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_slug` text NOT NULL,
	`position` integer NOT NULL,
	`video_id` text NOT NULL,
	`title` text NOT NULL,
	`channel` text,
	`views` integer,
	`duration_s` integer,
	`transcript` text,
	`matches` integer,
	`confidence` text,
	`reason` text,
	`outcome` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`game_slug`) REFERENCES `games`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `letsplay_candidates_game_video` ON `letsplay_candidates` (`game_slug`,`video_id`);--> statement-breakpoint
CREATE TABLE `llm_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_slug` text NOT NULL,
	`stage` text NOT NULL,
	`subject` text,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`duration_ms` integer NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cost_usd` real,
	`batch_size` integer DEFAULT 1 NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`decision` text NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`game_slug`) REFERENCES `games`(`slug`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `llm_runs_game_idx` ON `llm_runs` (`game_slug`,`id`);