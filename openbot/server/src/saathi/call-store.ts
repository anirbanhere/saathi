import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { saathiCallSessions as sessions } from "../db/schema";
import type { CallStore } from "./calls";
export function createCallStore(database: Database): CallStore {
  return {
    async insert(row) {
      await database
        .insert(sessions)
        .values({
          id: row.id,
          ownerUserId: row.owner,
          version: row.version,
          payload: row,
        });
    },
    async list(owner) {
      return (
        await database
          .select()
          .from(sessions)
          .where(eq(sessions.ownerUserId, owner))
          .orderBy(desc(sessions.createdAt))
          .limit(100)
      ).map((row) => row.payload);
    },
    async get(owner, id) {
      const [row] = await database
        .select()
        .from(sessions)
        .where(and(eq(sessions.ownerUserId, owner), eq(sessions.id, id)));
      return row?.payload ?? null;
    },
    async change(owner, id, version, patch) {
      const [row] = await database
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.ownerUserId, owner),
            eq(sessions.id, id),
            eq(sessions.version, version),
          ),
        );
      if (!row) return false;
      const changed = await database
        .update(sessions)
        .set({
          version: version + 1,
          payload: {
            ...row.payload,
            ...patch,
            id,
            owner,
            version: version + 1,
          },
        })
        .where(
          and(
            eq(sessions.ownerUserId, owner),
            eq(sessions.id, id),
            eq(sessions.version, version),
          ),
        )
        .returning({ id: sessions.id });
      return changed.length === 1;
    },
  };
}
