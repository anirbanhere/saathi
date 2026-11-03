import type { Database } from "bun:sqlite";
import { z } from "zod";
import { LocalError } from "./errors";

const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const threadSchema = z
  .object({
    id: z.uuid(),
    agent: z.enum(["saathi", "kitchen", "inventory"]),
    created: timestamp,
    updated: timestamp,
  })
  .strict();
const messageSchema = z
  .object({
    id: z.uuid(),
    role: z.enum(["user", "assistant"]),
    content: z
      .string()
      .min(1)
      .max(16000)
      .refine((s) => s.trim().length > 0),
    seq: z.number().int().min(0),
    content_type: z.literal("text"),
  })
  .strict();
const memorySchema = z
  .object({
    id: z.uuid(),
    content: z
      .string()
      .min(1)
      .max(2000)
      .refine((s) => s.trim().length > 0),
    created: timestamp,
    content_type: z.literal("text"),
  })
  .strict();
type Message = Pick<z.infer<typeof messageSchema>, "id" | "role" | "content">;
type Memory = Pick<z.infer<typeof memorySchema>, "id" | "content" | "created">;
type Thread = z.infer<typeof threadSchema> & { messages: Message[] };
const unavailable = () =>
  new LocalError("Text export data is unavailable.", 503);
const overflow = () =>
  new LocalError("Text export exceeds this demo's download budget.", 413);
function checked<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw unavailable();
  return parsed.data;
}

/** Internal owner context must be authenticated by the caller; synchronous bounded read snapshot only. */
export function createOwnedTextExport(
  db: Database,
  ownerInput: unknown,
  now: () => number = Date.now,
) {
  const owner = z.uuid().safeParse(ownerInput);
  if (!owner.success)
    throw new LocalError("Text export requires an active owner session.", 403);
  try {
    return db
      .transaction(() => {
        const exported_at = checked(timestamp, now());
        const active = (at: number) => {
          if (
            !db
              .query(
                "SELECT 1 FROM sessions s JOIN owners o ON o.id=s.owner WHERE s.owner=? AND typeof(s.expires)='integer' AND s.expires>? LIMIT 1",
              )
              .get(owner.data, at)
          )
            throw new LocalError(
              "Text export requires an active owner session.",
              403,
            );
        };
        active(exported_at);
        const result = {
          format: "saathi-text-export-v1" as const,
          scope: "conversations_and_reviewed_preferences" as const,
          complete_for_scope: true as const,
          exported_at,
          excluded: [
            "credentials_and_sessions",
            "source_evidence",
            "task_plans_and_appointments",
            "inference_and_speech_ledgers",
            "media_and_retained_transcripts",
            "provider_data",
            "backups",
          ],
          threads: [] as Thread[],
          memories: [] as Memory[],
        };
        let bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
        const add = (row: unknown, comma: number) => {
          bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + comma;
          if (bytes > 2_000_000) throw overflow();
        };
        const threads = db
          .query(
            "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id END id,CASE WHEN length(CAST(agent AS BLOB))<=9 THEN agent END agent,CASE WHEN typeof(created)='integer' THEN created END created,CASE WHEN typeof(updated)='integer' THEN updated END updated FROM threads WHERE owner=? ORDER BY created,id LIMIT 31",
          )
          .all(owner.data);
        if (threads.length > 30) throw overflow();
        for (const raw of threads) {
          active(checked(timestamp, now()));
          const thread: Thread = {
            ...checked(threadSchema, raw),
            messages: [],
          };
          add(thread, result.threads.length ? 1 : 0);
          const messages = db
            .query(
              "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id END id,CASE WHEN length(CAST(role AS BLOB))<=9 THEN role END role,CASE WHEN length(CAST(content AS BLOB))<=64000 THEN content ELSE NULL END content,CASE WHEN typeof(seq)='integer' THEN seq END seq,typeof(content) content_type FROM messages WHERE thread=? ORDER BY seq,id LIMIT 101",
            )
            .all(thread.id);
          if (messages.length > 100) throw overflow();
          for (const [index, rawMessage] of messages.entries()) {
            const row = checked(messageSchema, rawMessage);
            if (
              row.seq !== index ||
              (row.role === "user" && row.content.length > 2000)
            )
              throw unavailable();
            const message = {
              id: row.id,
              role: row.role,
              content: row.content,
            };
            add(message, index ? 1 : 0);
            thread.messages.push(message);
          }
          result.threads.push(thread);
        }
        active(checked(timestamp, now()));
        const memories = db
          .query(
            "SELECT CASE WHEN length(CAST(id AS BLOB))=36 THEN id END id,CASE WHEN length(CAST(content AS BLOB))<=8000 THEN content ELSE NULL END content,CASE WHEN typeof(created)='integer' THEN created END created,typeof(content) content_type FROM memories WHERE owner=? ORDER BY created,id LIMIT 21",
          )
          .all(owner.data);
        if (memories.length > 20) throw overflow();
        for (const raw of memories) {
          const row = checked(memorySchema, raw),
            memory = { id: row.id, content: row.content, created: row.created };
          add(memory, result.memories.length ? 1 : 0);
          result.memories.push(memory);
        }
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > 2_000_000)
          throw overflow();
        active(checked(timestamp, now()));
        return result;
      })
      .deferred();
  } catch (error) {
    if (error instanceof LocalError) throw error;
    throw unavailable();
  }
}
