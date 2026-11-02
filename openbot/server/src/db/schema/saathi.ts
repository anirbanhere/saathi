import {
  bigserial,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./core";
import { jsonb } from "./json";
import type { CallRecord } from "../../saathi/calls";

export const saathiCallSessions = pgTable(
  "saathi_call_sessions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(0),
    payload: jsonb("payload").$type<CallRecord>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("saathi_calls_owner_created").on(table.ownerUserId, table.createdAt),
  ],
);

export const saathiModelKeys = pgTable(
  "saathi_model_keys",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.provider] }),
    check(
      "saathi_model_provider",
      sql`${table.provider} in ('openai', 'anthropic', 'meta')`,
    ),
  ],
);

export const saathiPreferences = pgTable(
  "saathi_preferences",
  {
    ownerUserId: text("owner_user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider"),
  },
  (table) => [
    check(
      "saathi_preference_provider",
      sql`${table.provider} in ('openai', 'anthropic', 'meta')`,
    ),
  ],
);

export const saathiConnections = pgTable(
  "saathi_connections",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    encryptedToken: text("encrypted_token").notNull(),
    agentId: text("agent_id").notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull(),
    participantId: text("participant_id"),
    pairingHash: text("pairing_hash"),
    pairingExpiresAt: timestamp("pairing_expires_at", { withTimezone: true }),
    status: text("status").notNull().default("pairing"),
    cursor: integer("cursor").notNull().default(0),
    generation: integer("generation").notNull().default(1),
    cancelVersion: integer("cancel_version").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    nextSendAt: timestamp("next_send_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "saathi_connection_status",
      sql`${table.status} in ('pairing', 'connected', 'error', 'disconnected')`,
    ),
  ],
);

export const saathiMessages = pgTable(
  "saathi_messages",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => saathiConnections.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    payload: jsonb("payload").notNull(),
    cancelVersion: integer("cancel_version").notNull().default(0),
    state: text("state").notNull().default("queued"),
    reply: text("reply"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("saathi_messages_connection_message_idx").on(
      table.connectionId,
      table.messageId,
    ),
  ],
);

export const saathiOutbox = pgTable(
  "saathi_outbox",
  {
    id: text("id").primaryKey(),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => saathiConnections.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    state: text("state").notNull().default("queued"),
    remoteId: text("remote_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("saathi_outbox_connection_state_idx").on(
      table.connectionId,
      table.state,
      table.sequence,
    ),
  ],
);
