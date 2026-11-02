import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  saathiModelKeys as keys,
  saathiPreferences as preferences,
} from "../db/schema";
import {
  type ModelKeyStore,
  type ModelProvider,
  modelProvider,
} from "./models";

export function createModelKeyStore(db: Database): ModelKeyStore {
  return {
    async save(owner, provider, value) {
      await db.transaction(async (tx) => {
        await tx
          .insert(keys)
          .values({ ownerUserId: owner, provider, ...value })
          .onConflictDoUpdate({
            target: [keys.ownerUserId, keys.provider],
            set: { ...value, updatedAt: new Date() },
          });
        await tx
          .insert(preferences)
          .values({ ownerUserId: owner, provider })
          .onConflictDoUpdate({
            target: preferences.ownerUserId,
            set: { provider },
          });
      });
    },
    async select(owner, provider, model) {
      return db.transaction(async (tx) => {
        const changed = await tx
          .update(keys)
          .set({ model, updatedAt: new Date() })
          .where(and(eq(keys.ownerUserId, owner), eq(keys.provider, provider)))
          .returning({ provider: keys.provider });
        if (!changed.length) return false;
        await tx
          .insert(preferences)
          .values({ ownerUserId: owner, provider })
          .onConflictDoUpdate({
            target: preferences.ownerUserId,
            set: { provider },
          });
        return true;
      });
    },
    async read(owner, provider) {
      let selected: string | null | undefined = provider;
      if (!selected) {
        const [preference] = await db
          .select()
          .from(preferences)
          .where(eq(preferences.ownerUserId, owner));
        selected = preference?.provider;
      }
      if (!selected) return null;
      const [row] = await db
        .select()
        .from(keys)
        .where(and(eq(keys.ownerUserId, owner), eq(keys.provider, selected)));
      return row
        ? {
            provider: modelProvider.parse(row.provider),
            model: row.model,
            encryptedKey: row.encryptedKey,
          }
        : null;
    },
    async list(owner) {
      const [preference] = await db
        .select()
        .from(preferences)
        .where(eq(preferences.ownerUserId, owner));
      const rows = await db
        .select({ provider: keys.provider, model: keys.model })
        .from(keys)
        .where(eq(keys.ownerUserId, owner));
      return rows.map((row) => ({
        ...row,
        provider: row.provider as ModelProvider,
        selected: row.provider === preference?.provider,
      }));
    },
    async revoke(owner, provider) {
      await db.transaction(async (tx) => {
        await tx
          .delete(keys)
          .where(and(eq(keys.ownerUserId, owner), eq(keys.provider, provider)));
        await tx
          .update(preferences)
          .set({ provider: null })
          .where(
            and(
              eq(preferences.ownerUserId, owner),
              eq(preferences.provider, provider),
            ),
          );
      });
    },
  };
}
