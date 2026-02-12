CREATE TABLE `chat_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_message_id` text,
	`file_name` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`chat_message_id`) REFERENCES `chat_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
