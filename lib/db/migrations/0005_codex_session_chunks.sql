CREATE TABLE `agent_session_sequences` (
	`session_id` text PRIMARY KEY NOT NULL,
	`next_sequence` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_session_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`stream_type` text NOT NULL,
	`sequence` integer NOT NULL,
	`chunk_key` text,
	`content` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_chunks_session_sequence_unique` ON `agent_session_chunks` (`session_id`,`sequence`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_session_chunks_session_stream_key_unique` ON `agent_session_chunks` (`session_id`,`stream_type`,`chunk_key`);
--> statement-breakpoint
CREATE INDEX `agent_session_chunks_session_stream_sequence_idx` ON `agent_session_chunks` (`session_id`,`stream_type`,`sequence`);
