CREATE TABLE "saathi_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"participant_id" text,
	"pairing_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"status" text DEFAULT 'pairing' NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"cancel_version" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_send_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saathi_connections_owner_user_id_unique" UNIQUE("owner_user_id"),
	CONSTRAINT "saathi_connections_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "saathi_connection_status" CHECK ("saathi_connections"."status" in ('pairing', 'connected', 'error', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "saathi_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"message_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"cancel_version" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"reply" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saathi_model_keys" (
	"owner_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"encrypted_key" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saathi_model_keys_owner_user_id_provider_pk" PRIMARY KEY("owner_user_id","provider"),
	CONSTRAINT "saathi_model_provider" CHECK ("saathi_model_keys"."provider" in ('openai', 'anthropic'))
);
--> statement-breakpoint
CREATE TABLE "saathi_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence" bigserial NOT NULL,
	"connection_id" text NOT NULL,
	"text" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"remote_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saathi_preferences" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"provider" text,
	CONSTRAINT "saathi_preference_provider" CHECK ("saathi_preferences"."provider" in ('openai', 'anthropic'))
);
--> statement-breakpoint
ALTER TABLE "saathi_connections" ADD CONSTRAINT "saathi_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saathi_messages" ADD CONSTRAINT "saathi_messages_connection_id_saathi_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."saathi_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saathi_model_keys" ADD CONSTRAINT "saathi_model_keys_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saathi_outbox" ADD CONSTRAINT "saathi_outbox_connection_id_saathi_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."saathi_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saathi_preferences" ADD CONSTRAINT "saathi_preferences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saathi_messages_connection_message_idx" ON "saathi_messages" USING btree ("connection_id","message_id");--> statement-breakpoint
CREATE INDEX "saathi_outbox_connection_state_idx" ON "saathi_outbox" USING btree ("connection_id","state","sequence");