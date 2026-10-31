import type { Database } from "bun:sqlite";

export const mediaInvalidationTriggerSql = `CREATE TRIGGER IF NOT EXISTS media_invalidates_stt AFTER UPDATE OF consent_revision,state ON owned_media
    WHEN NEW.consent_revision!=OLD.consent_revision OR NEW.state!=OLD.state BEGIN
      UPDATE stt_admissions SET
        state=CASE WHEN state='cancelled' THEN state WHEN state IN('reserved','claimed') OR pending=1 THEN CASE WHEN NEW.state='expired' THEN 'expired' ELSE 'revoked' END ELSE state END,
        pending=CASE WHEN pending=1 AND claimed_at IS NOT NULL THEN 1 ELSE 0 END,
        claim_hash=CASE WHEN pending=1 AND claimed_at IS NOT NULL THEN claim_hash ELSE NULL END,
        outcome=NULL,updated=COALESCE(NEW.consent_changed_at,NEW.removed,NEW.created)
      WHERE media=NEW.id;
    END;`;

export function migrateSttExecution(db: Database) {
  db.exec("DROP TRIGGER IF EXISTS media_invalidates_stt");
  const columns = db
    .query<{ name: string }, []>("PRAGMA table_info(stt_admissions)")
    .all();
  if (!columns.some((column) => column.name === "pending")) {
    db.exec(`DROP INDEX IF EXISTS stt_pending_owner; ALTER TABLE stt_admissions RENAME TO stt_admissions_v10;
      CREATE TABLE stt_admissions(
        id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
        request TEXT NOT NULL,digest TEXT NOT NULL,media TEXT NOT NULL REFERENCES owned_media(id) ON DELETE CASCADE,
        consent_revision INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 100 AND 29000),language_hint TEXT,
        state TEXT NOT NULL CHECK(state IN('reserved','claimed','completed','failed','cancelled','interrupted','blocked','revoked','expired')),
        created INTEGER NOT NULL,updated INTEGER NOT NULL,expires INTEGER NOT NULL,
        pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN(0,1)),claim_hash TEXT,claimed_at INTEGER,claim_deadline INTEGER,
        settlement_digest TEXT,outcome TEXT CHECK(outcome IS NULL OR length(outcome)<=20000),settled_at INTEGER,failure_code TEXT,
        UNIQUE(owner,request),CHECK((state IN('reserved','claimed') AND pending=1) OR (state IN('completed','failed','interrupted','blocked') AND pending=0) OR state IN('cancelled','revoked','expired')),
        CHECK(outcome IS NULL OR state IN('completed','failed'))
      );
      INSERT INTO stt_admissions(id,owner,request,digest,media,consent_revision,content_hash,role,duration_ms,language_hint,state,created,updated,expires,pending)
        SELECT id,owner,request,digest,media,consent_revision,content_hash,role,duration_ms,language_hint,state,created,updated,expires,CASE WHEN state='reserved' THEN 1 ELSE 0 END FROM stt_admissions_v10;
      DROP TABLE stt_admissions_v10;`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS stt_pending_owner ON stt_admissions(owner) WHERE pending=1;
    ${mediaInvalidationTriggerSql}`);
}
