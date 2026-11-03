import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DemoAppointments, migrateAppointments } from "./appointments";
import { ownDatabase } from "./database-ownership";
import { LocalError } from "./errors";
import { migrateMediaConsent } from "./media-consent";
import { type MediaLimits, migrateMedia, OwnedMedia } from "./media-store";
import { migratePlanReads, PlanReads } from "./plan-reads";
import { migratePlans, TaskPlans } from "./plans";
import type { SearchEvidence } from "./search";
import {
  migrateSttAdmissions,
  type SttAdmissionLimits,
  SttAdmissions,
} from "./stt-admission";
import {
  migrateSttBudgetHolds,
  migrateSttHoldCancellation,
  type SttBalanceReader,
  SttBudgetHolds,
} from "./stt-budget-holds";
import { migrateSttExecution } from "./stt-execution-schema";
import { migrateSttHoldRoles, type SttRoleReader } from "./stt-hold-roles";
import {
  migrateSttPolicyCatalogue,
  SttPolicyCatalogue,
  type SttPolicyCatalogueLimits,
  sttPolicyCatalogueLimits,
} from "./stt-policy-catalog";

export { LocalError } from "./errors";
export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  evidence?: SearchEvidence | null;
};
type Thread = {
  id: string;
  owner: string;
  agent: string;
  created: number;
  updated: number;
};
type Run = {
  id: string;
  owner: string;
  thread: string;
  request: string;
  digest: string;
  state: "running" | "completed" | "failed" | "interrupted";
  reply: string | null;
  model: string | null;
};
type Memory = { id: string; content: string; created: number };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export class SelfHostedStore {
  readonly appointments: DemoAppointments;
  readonly plans: TaskPlans;
  readonly planReads: PlanReads;
  readonly media: OwnedMedia;
  readonly sttAdmissions: SttAdmissions;
  readonly sttPolicies: SttPolicyCatalogue;
  readonly sttBudgetHolds: SttBudgetHolds;
  private db: Database;
  private release: () => void;
  private closed = false;
  constructor(
    path: string,
    private options: {
      limits?: { global: number; owner: number };
      now?: () => number;
      mediaLimits?: Partial<MediaLimits>;
      sttLimits?: Partial<SttAdmissionLimits>;
      sttPolicyLimits?: Partial<SttPolicyCatalogueLimits>;
      sttBalanceReader?: SttBalanceReader;
      sttRoleReader?: SttRoleReader;
    } = {},
  ) {
    const policyLimits = sttPolicyCatalogueLimits(options.sttPolicyLimits);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.release = ownDatabase(path);
    let opened: Database | undefined;
    try {
      this.db = new Database(path, { create: true, strict: true });
      opened = this.db;
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS version (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
        INSERT OR IGNORE INTO version VALUES(1,1);
        CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), agent TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS threads_owner ON threads(owner);
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, seq INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), thread TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, request TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, reply TEXT, UNIQUE(owner,request));
        CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES owners(id), content TEXT NOT NULL, created INTEGER NOT NULL);`);
      const version = this.db
        .query<{ value: number }, []>("SELECT value FROM version WHERE id=1")
        .get();
      if (version?.value === 1)
        this.db
          .transaction(() => {
            this.db.exec(
              "ALTER TABLE runs ADD COLUMN model TEXT; UPDATE version SET value=2 WHERE id=1",
            );
          })
          .immediate();
      if (version?.value === 1 || version?.value === 2)
        this.db
          .transaction(() => {
            this.db.exec(
              "CREATE TABLE IF NOT EXISTS inference_usage(run TEXT PRIMARY KEY, owner TEXT NOT NULL, day TEXT NOT NULL); CREATE INDEX IF NOT EXISTS usage_day_owner ON inference_usage(day,owner); UPDATE version SET value=3 WHERE id=1",
            );
          })
          .immediate();
      else if (
        version?.value !== 3 &&
        version?.value !== 4 &&
        version?.value !== 5 &&
        version?.value !== 6 &&
        version?.value !== 7 &&
        version?.value !== 8 &&
        version?.value !== 9 &&
        version?.value !== 10 &&
        version?.value !== 11 &&
        version?.value !== 12 &&
        version?.value !== 13 &&
        version?.value !== 14 &&
        version?.value !== 15
      )
        throw new LocalError("Unsupported local schema version.", 503);
      if (version && version.value <= 3)
        this.db
          .transaction(() =>
            this.db.exec(
              "CREATE TABLE IF NOT EXISTS run_evidence(run TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE, message TEXT UNIQUE NOT NULL REFERENCES messages(id) ON DELETE CASCADE, payload TEXT NOT NULL); UPDATE version SET value=4 WHERE id=1",
            ),
          )
          .immediate();
      if (version && version.value <= 4)
        this.db
          .transaction(() => {
            migrateAppointments(this.db);
            this.db.exec("UPDATE version SET value=5 WHERE id=1");
          })
          .immediate();
      this.appointments = new DemoAppointments(this.db, options.now);
      if (version && version.value <= 5)
        this.db
          .transaction(() => {
            migratePlans(this.db);
            this.db.exec("UPDATE version SET value=6 WHERE id=1");
          })
          .immediate();
      if (version && version.value <= 6)
        this.db
          .transaction(() => {
            migratePlanReads(this.db);
            this.db.exec("UPDATE version SET value=7 WHERE id=1");
          })
          .immediate();
      if (version && version.value <= 7)
        this.db
          .transaction(() => {
            migrateMedia(this.db);
            this.db.exec("UPDATE version SET value=8 WHERE id=1");
          })
          .immediate();
      if (version && version.value <= 8)
        this.db
          .transaction(() => {
            migrateMediaConsent(this.db, (options.now ?? Date.now)());
            this.db.exec("UPDATE version SET value=9 WHERE id=1");
          })
          .immediate();
      this.media = new OwnedMedia(this.db, options.now, options.mediaLimits);
      if (version && version.value <= 9)
        this.db
          .transaction(() => {
            migrateSttAdmissions(this.db);
            this.db.exec("UPDATE version SET value=10 WHERE id=1");
          })
          .immediate();
      if (version && version.value <= 10)
        this.db
          .transaction(() => {
            migrateSttExecution(this.db);
            this.db.exec("UPDATE version SET value=11 WHERE id=1");
          })
          .immediate();
      this.sttAdmissions = new SttAdmissions(
        this.db,
        this.media,
        options.now,
        options.sttLimits,
      );
      if (version && version.value <= 11)
        this.db
          .transaction(() => {
            migrateSttPolicyCatalogue(this.db);
            this.db.exec("UPDATE version SET value=12 WHERE id=1");
          })
          .immediate();
      this.sttPolicies = new SttPolicyCatalogue(
        this.db,
        options.now,
        policyLimits,
      );
      if (version && version.value <= 12)
        this.db
          .transaction(() => {
            migrateSttBudgetHolds(this.db);
            this.db.exec("UPDATE version SET value=13 WHERE id=1");
          })
          .immediate();
      if (version && version.value <= 13)
        this.db
          .transaction(() => {
            migrateSttHoldCancellation(this.db);
            this.db.exec("UPDATE version SET value=14 WHERE id=1");
          })
          .immediate();
      if (version && version.value <= 14)
        this.db
          .transaction(() => {
            migrateSttHoldRoles(this.db);
            this.db.exec("UPDATE version SET value=15 WHERE id=1");
          })
          .immediate();
      this.sttBudgetHolds = new SttBudgetHolds(
        this.db,
        this.media,
        this.sttPolicies,
        options.now,
        options.sttBalanceReader,
        options.sttRoleReader,
      );
      this.sttAdmissions.recoverOnExclusiveStartup();
      this.plans = new TaskPlans(this.db, {
        reserve: (owner, id) => this.reserveInference(owner, id),
        busy: (owner) => this.inferenceRunning(owner),
        now: options.now ?? Date.now,
      });
      this.plans.recover();
      this.planReads = new PlanReads(
        this.db,
        this.plans,
        this.appointments,
        options.now,
      );
      // Single-process lock proves no live writer is using these runs. Never automatically replay.
      this.db.exec("UPDATE runs SET state='interrupted' WHERE state='running'");
    } catch (error) {
      opened?.close();
      this.release();
      throw error;
    }
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.release();
      this.closed = true;
    }
  }
  createSession() {
    return this.db
      .transaction(() => {
        const count = this.db
          .query<{ n: number }, []>("SELECT count(*) n FROM owners")
          .get();
        if (!count)
          throw new LocalError("Local workspace storage is unavailable.", 503);
        if (count.n >= 50)
          throw new LocalError("Local workspace budget reached.", 429);
        const owner = randomUUID(),
          token = randomBytes(32).toString("base64url"),
          csrf = randomBytes(24).toString("base64url");
        this.db.query("INSERT INTO owners VALUES(?)").run(owner);
        this.db
          .query("INSERT INTO sessions VALUES(?,?,?,?)")
          .run(hash(token), owner, csrf, Date.now() + 86_400_000);
        return { owner, token, csrf };
      })
      .immediate();
  }
  session(token: string) {
    return this.db
      .query<{ owner: string; csrf: string }, [string, number]>(
        "SELECT owner,csrf FROM sessions WHERE token=? AND expires>?",
      )
      .get(hash(token), Date.now());
  }
  createThread(owner: string, agent: string) {
    if (!["saathi", "kitchen", "inventory"].includes(agent))
      throw new LocalError("Unknown assistant.");
    return this.db
      .transaction(() => {
        if (this.listThreads(owner).length >= 30)
          throw new LocalError("Local thread budget reached.", 429);
        const id = randomUUID(),
          now = Date.now();
        this.db
          .query("INSERT INTO threads VALUES(?,?,?,?,?)")
          .run(id, owner, agent, now, now);
        return this.thread(owner, id);
      })
      .immediate();
  }
  listThreads(owner: string) {
    return this.db
      .query<Thread, [string]>(
        "SELECT * FROM threads WHERE owner=? ORDER BY updated DESC LIMIT 30",
      )
      .all(owner);
  }
  thread(owner: string, id: string) {
    const row = this.db
      .query<Thread, [string, string]>(
        "SELECT * FROM threads WHERE id=? AND owner=?",
      )
      .get(id, owner);
    if (!row) throw new LocalError("Thread not found.", 404);
    const messages = this.db
      .query<StoredMessage & { payload: string | null }, [string]>(
        "SELECT m.id,m.role,m.content,e.payload FROM messages m LEFT JOIN run_evidence e ON e.message=m.id WHERE m.thread=? ORDER BY m.seq",
      )
      .all(id)
      .map(({ payload, ...message }) => ({
        ...message,
        evidence: payload ? (JSON.parse(payload) as SearchEvidence) : null,
      }));
    const lastRun = this.db
      .query<
        { id: string; state: Run["state"]; model: string | null },
        [string]
      >(
        "SELECT id,state,model FROM runs WHERE thread=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(id);
    return { ...row, messages, lastRun };
  }
  deleteThread(owner: string, id: string) {
    return this.db
      .transaction(() => {
        this.thread(owner, id);
        if (
          this.db
            .query("SELECT 1 FROM runs WHERE thread=? AND state='running'")
            .get(id)
        )
          throw new LocalError("This thread is still running.", 409);
        this.db
          .query("DELETE FROM threads WHERE id=? AND owner=?")
          .run(id, owner);
      })
      .immediate();
  }
  beginRun(
    owner: string,
    threadId: string,
    request: string,
    text: string,
    model: string | null = null,
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(request) ||
      !text.trim() ||
      text.length > 2000
    )
      throw new LocalError("Use a request ID and1–2000 text characters.");
    return this.db
      .transaction(() => {
        const thread = this.thread(owner, threadId),
          digest = hash(
            model === null
              ? `${threadId}\0${text}`
              : JSON.stringify([threadId, text, model]),
          );
        const prior = this.previousRun(owner, request);
        if (prior) {
          if (prior.digest !== digest)
            throw new LocalError(
              "Request ID conflicts with an earlier message.",
              409,
            );
          return { ...prior, fresh: false };
        }
        if (this.inferenceRunning(owner))
          throw new LocalError(
            "An answer is already running in this workspace.",
            409,
          );
        // Reserve both the new question and its possible answer, even after failures.
        if (thread.messages.length + 2 > 100)
          throw new LocalError("Thread message budget reached.", 429);
        const id = randomUUID();
        this.reserveInference(owner, id);
        this.db
          .query(
            "INSERT INTO runs(id,owner,thread,request,digest,state,reply,model) VALUES(?,?,?,?,?,'running',NULL,?)",
          )
          .run(id, owner, threadId, request, digest, model);
        this.db
          .query("INSERT INTO messages VALUES(?,?,?,?,?)")
          .run(
            randomUUID(),
            threadId,
            "user",
            text.trim(),
            thread.messages.length,
          );
        return {
          id,
          owner,
          thread: threadId,
          request,
          digest,
          state: "running" as const,
          reply: null,
          model,
          fresh: true,
        };
      })
      .immediate();
  }
  completeRun(
    owner: string,
    id: string,
    reply: string,
    evidence?: SearchEvidence,
  ) {
    if (!reply.trim() || reply.length > 16000)
      throw new LocalError(
        "The model response exceeded the local answer budget.",
        502,
      );
    this.db
      .transaction(() => {
        const run = this.run(owner, id);
        if (run.state === "completed") return;
        if (run.state !== "running")
          throw new LocalError("This run cannot be completed.", 409);
        const count = this.thread(owner, run.thread).messages.length;
        const messageId = randomUUID();
        this.db
          .query("INSERT INTO messages VALUES(?,?,?,?,?)")
          .run(messageId, run.thread, "assistant", reply, count);
        if (evidence)
          this.db
            .query("INSERT INTO run_evidence VALUES(?,?,?)")
            .run(id, messageId, JSON.stringify(evidence));
        this.db
          .query(
            "UPDATE runs SET state='completed',reply=? WHERE id=? AND owner=?",
          )
          .run(reply, id, owner);
        this.db
          .query("UPDATE threads SET updated=? WHERE id=?")
          .run(Date.now(), run.thread);
      })
      .immediate();
  }
  failRun(owner: string, id: string) {
    this.db
      .query(
        "UPDATE runs SET state='failed' WHERE id=? AND owner=? AND state='running'",
      )
      .run(id, owner);
  }
  evidence(owner: string, id: string): SearchEvidence | null {
    this.run(owner, id);
    const row = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM run_evidence WHERE run=?",
      )
      .get(id);
    return row ? (JSON.parse(row.payload) as SearchEvidence) : null;
  }
  previousRun(owner: string, request: string) {
    return this.db
      .query<Run, [string, string]>(
        "SELECT * FROM runs WHERE owner=? AND request=?",
      )
      .get(owner, request);
  }
  limits() {
    return this.options.limits ? { ...this.options.limits } : null;
  }
  private inferenceRunning(owner: string) {
    return Boolean(
      this.db
        .query(
          "SELECT 1 FROM runs WHERE owner=? AND state='running' UNION ALL SELECT 1 FROM task_plans WHERE owner=? AND pending=1 LIMIT 1",
        )
        .get(owner, owner),
    );
  }
  private reserveInference(owner: string, run: string) {
    const day = new Date((this.options.now ?? Date.now)())
      .toISOString()
      .slice(0, 10);
    const limits = this.options.limits;
    if (limits) {
      const total = this.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) n FROM inference_usage WHERE day=?",
        )
        .get(day);
      const own = this.db
        .query<{ n: number }, [string, string]>(
          "SELECT count(*) n FROM inference_usage WHERE day=? AND owner=?",
        )
        .get(day, owner);
      if (!total || !own)
        throw new LocalError("Demo allowance storage is unavailable.", 503);
      if (total.n >= limits.global || own.n >= limits.owner)
        throw new LocalError(
          "Demo daily model-call allowance reached. It resets at midnight UTC; no new message or inference was started.",
          429,
        );
    }
    this.db
      .query("INSERT INTO inference_usage VALUES(?,?,?)")
      .run(run, owner, day);
  }
  run(owner: string, id: string) {
    const row = this.db
      .query<Run, [string, string]>("SELECT * FROM runs WHERE id=? AND owner=?")
      .get(id, owner);
    if (!row) throw new LocalError("Run not found.", 404);
    return row;
  }
  memories(owner: string) {
    return this.db
      .query<Memory, [string]>(
        "SELECT id,content,created FROM memories WHERE owner=? ORDER BY created,id LIMIT 20",
      )
      .all(owner);
  }
  saveMemory(owner: string, content: string, reviewed: boolean) {
    if (reviewed !== true)
      throw new LocalError("Explicit memory review is required.", 403);
    if (!content.trim() || content.length > 2000)
      throw new LocalError("Use1–2000 characters for a memory.");
    return this.db
      .transaction(() => {
        if (this.memories(owner).length >= 20)
          throw new LocalError("Memory budget reached.", 429);
        const row = {
          id: randomUUID(),
          content: content.trim(),
          created: Date.now(),
        };
        this.db
          .query("INSERT INTO memories VALUES(?,?,?,?)")
          .run(row.id, owner, row.content, row.created);
        return row;
      })
      .immediate();
  }
  deleteMemory(owner: string, id: string) {
    const result = this.db
      .query("DELETE FROM memories WHERE id=? AND owner=?")
      .run(id, owner);
    if (!result.changes) throw new LocalError("Memory not found.", 404);
  }
}
