import type { Database } from "bun:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";

const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const version = z.number().int().min(1).max(100);
const slot = z.enum(["10:00", "11:00", "15:00"]);
const locale = z.enum(["en-IN", "hi-IN", "ta-IN"]);
const createSchema = z
  .object({ request_id: requestId, date: z.string().length(10), locale })
  .strict();
const previewSchema = z.object({ slot_id: slot, version }).strict();
const decisionSchema = z
  .object({
    request_id: requestId,
    decision: z.enum(["approve", "reject"]),
    version,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
type State =
  | "AWAITING_SELECTION"
  | "APPROVAL_PENDING"
  | "COMPLETED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "UNAVAILABLE";
type Quote = {
  provider: string;
  clinic: string;
  service: string;
  date: string;
  slot_id: string;
  timezone: string;
  city: string;
  duration_minutes: number;
  amount: number;
  currency: string;
  terms: string;
  hash: string;
};
type Receipt = {
  mode: "mock";
  reference: string;
  confirmed_at: number;
  summary: string;
  quote: Quote;
};
type Row = {
  id: string;
  owner: string;
  request: string;
  digest: string;
  date: string;
  locale: z.infer<typeof locale>;
  state: State;
  version: number;
  plan: string;
  preview: string | null;
  nonce_hash: string | null;
  expires: number | null;
  receipt: string | null;
  created: number;
  updated: number;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new LocalError("Invalid demo appointment fields.");
  return parsed.data;
};
const today = (now: number) =>
  new Date(now + 19800000).toISOString().slice(0, 10);
const terminal = new Set<State>(["COMPLETED", "REJECTED", "CANCELLED"]);
const plan = [
  {
    id: "availability",
    tool: "demo.appointments.list",
    risk: "READ",
    requires_approval: false,
  },
  {
    id: "preview",
    tool: "demo.appointments.prepare",
    risk: "DRAFT",
    requires_approval: false,
  },
  {
    id: "book",
    tool: "demo.appointments.book",
    risk: "BOOK",
    requires_approval: true,
  },
  {
    id: "verify",
    tool: "demo.appointments.receipt",
    risk: "READ",
    requires_approval: false,
  },
];

export function migrateAppointments(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS demo_tasks(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES owners(id),request TEXT NOT NULL,digest TEXT NOT NULL,date TEXT NOT NULL,locale TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,plan TEXT NOT NULL,preview TEXT,nonce_hash TEXT,expires INTEGER,receipt TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(owner,request));
 CREATE INDEX IF NOT EXISTS demo_owner ON demo_tasks(owner,created);
 CREATE TABLE IF NOT EXISTS demo_bookings(task TEXT PRIMARY KEY REFERENCES demo_tasks(id) ON DELETE CASCADE,date TEXT NOT NULL,slot TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,UNIQUE(date,slot));
 CREATE TABLE IF NOT EXISTS demo_decisions(owner TEXT NOT NULL REFERENCES owners(id),request TEXT NOT NULL,task TEXT NOT NULL REFERENCES demo_tasks(id) ON DELETE CASCADE,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,request));
 CREATE TABLE IF NOT EXISTS demo_audit(task TEXT NOT NULL REFERENCES demo_tasks(id) ON DELETE CASCADE,seq INTEGER NOT NULL,event TEXT NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(task,seq));`);
}

/** Controlled SQL mock only. No network/provider/LLM authority or real appointment is implied. */
export class DemoAppointments {
  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}
  private row(owner: string, id: string) {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM demo_tasks WHERE id=? AND owner=?",
      )
      .get(id, owner);
    if (!row) throw new LocalError("Demo task not found.", 404);
    return row;
  }
  private audit(row: Row, event: string) {
    const count = this.db
      .query<{ n: number }, [string]>(
        "SELECT count(*) n FROM demo_audit WHERE task=?",
      )
      .get(row.id);
    if (!count) throw new LocalError("Demo audit storage unavailable.", 503);
    this.db
      .query("INSERT INTO demo_audit VALUES(?,?,?,?,?)")
      .run(row.id, count.n, event, row.state, this.now());
  }
  private change(row: Row, state: State, event: string) {
    this.db
      .query(
        "UPDATE demo_tasks SET state=?,version=version+1,nonce_hash=NULL,expires=NULL,updated=? WHERE id=?",
      )
      .run(state, this.now(), row.id);
    row.state = state;
    row.version++;
    this.audit(row, event);
  }
  private view(row: Row) {
    return {
      id: row.id,
      mode: "mock" as const,
      provider: "demo-clinic",
      date: row.date,
      locale: row.locale,
      state: row.state,
      version: row.version,
      plan: JSON.parse(row.plan) as typeof plan,
      preview: row.preview ? (JSON.parse(row.preview) as Quote) : null,
      expires_at: row.expires,
      receipt: row.receipt ? (JSON.parse(row.receipt) as Receipt) : null,
      created: row.created,
      updated: row.updated,
      audit: this.db
        .query<{ event: string; state: State; at: number }, [string]>(
          "SELECT event,state,at FROM demo_audit WHERE task=? ORDER BY seq",
        )
        .all(row.id),
    };
  }
  private expire(owner: string, id: string) {
    this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (
          row.state === "APPROVAL_PENDING" &&
          (row.expires ?? 0) <= this.now()
        ) {
          this.db
            .query(
              "UPDATE demo_tasks SET state='EXPIRED',nonce_hash=NULL,updated=? WHERE id=?",
            )
            .run(this.now(), id);
          row.state = "EXPIRED";
          this.audit(row, "approval.expired");
        }
      })
      .immediate();
  }
  get(owner: string, id: string) {
    this.expire(owner, id);
    return this.view(this.row(owner, id));
  }
  list(owner: string) {
    return this.db
      .query<{ id: string }, [string]>(
        "SELECT id FROM demo_tasks WHERE owner=? ORDER BY created DESC,rowid DESC LIMIT 30",
      )
      .all(owner)
      .map((row) => this.get(owner, row.id));
  }
  options(date: string = today(this.now())) {
    const min = today(this.now()),
      max = new Date(Date.parse(`${min}T00:00:00Z`) + 30 * 86400000)
        .toISOString()
        .slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
      date < min ||
      date > max
    )
      throw new LocalError(
        "Choose a valid India date from today through the next 30 days.",
      );
    const reserved = new Set(
      this.db
        .query<{ slot: string }, [string]>(
          "SELECT slot FROM demo_bookings WHERE date=?",
        )
        .all(date)
        .map((row) => row.slot),
    );
    return {
      mode: "mock" as const,
      timezone: "Asia/Kolkata",
      min_date: min,
      max_date: max,
      date,
      clinic: "Saathi DEMO Dental · Chennai",
      slots: slot.options
        .filter(
          (id) =>
            !reserved.has(id) &&
            Date.parse(`${date}T${id}:00+05:30`) > this.now(),
        )
        .map((id) => ({ id, label: `${id} IST · 30 minutes · MOCK ₹500` })),
    };
  }
  create(owner: string, input: unknown) {
    const body = parse(createSchema, input);
    return this.db
      .transaction(() => {
        const digest = hash(JSON.stringify([body.date, body.locale]));
        const prior = this.db
          .query<Row, [string, string]>(
            "SELECT * FROM demo_tasks WHERE owner=? AND request=?",
          )
          .get(owner, body.request_id);
        if (prior) {
          if (prior.digest !== digest)
            throw new LocalError(
              "Request ID conflicts with an earlier task.",
              409,
            );
          return this.view(prior);
        }
        if (this.list(owner).length >= 30)
          throw new LocalError("Demo task budget reached.", 429);
        if (!this.options(body.date).slots.length)
          throw new LocalError(
            "No demo slots remain. Choose another date.",
            409,
          );
        const id = randomUUID(),
          now = this.now();
        this.db
          .query(
            "INSERT INTO demo_tasks VALUES(?,?,?,?,?,?,'AWAITING_SELECTION',1,?,NULL,NULL,NULL,NULL,?,?)",
          )
          .run(
            id,
            owner,
            body.request_id,
            digest,
            body.date,
            body.locale,
            JSON.stringify(plan),
            now,
            now,
          );
        const row = this.row(owner, id);
        this.audit(row, "task.created");
        return this.view(row);
      })
      .immediate();
  }
  preview(owner: string, id: string, input: unknown) {
    const body = parse(previewSchema, input);
    this.expire(owner, id);
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (row.version !== body.version)
          throw new LocalError("Task changed. Refresh and review again.", 409);
        if (terminal.has(row.state))
          throw new LocalError("This demo task is terminal.", 409);
        if (row.version >= 25)
          throw new LocalError(
            "Demo review budget reached. Cancel this task.",
            429,
          );
        if (
          !this.options(row.date).slots.some((slot) => slot.id === body.slot_id)
        )
          throw new LocalError(
            "Demo slot unavailable. Choose another slot.",
            409,
          );
        const fields = {
          provider: "demo-clinic",
          clinic: "Saathi DEMO Dental",
          service: "Dental cleaning (simulation)",
          date: row.date,
          slot_id: body.slot_id,
          timezone: "Asia/Kolkata",
          city: "Chennai",
          duration_minutes: 30,
          amount: 500,
          currency: "INR",
          terms:
            "MOCK only. No payment, real appointment or notification. Pre-commit cancellation only; the mock receipt is terminal.",
        };
        const quote: Quote = { ...fields, hash: hash(JSON.stringify(fields)) },
          nonce = randomBytes(32).toString("base64url");
        this.db
          .query(
            "UPDATE demo_tasks SET state='APPROVAL_PENDING',version=version+1,preview=?,nonce_hash=?,expires=?,updated=? WHERE id=?",
          )
          .run(
            JSON.stringify(quote),
            hash(nonce),
            this.now() + 600000,
            this.now(),
            id,
          );
        const next = this.row(owner, id);
        this.audit(next, "approval.requested");
        return { task: this.view(next), nonce };
      })
      .immediate();
  }
  decide(owner: string, id: string, input: unknown) {
    const body = parse(decisionSchema, input);
    this.expire(owner, id);
    return this.db
      .transaction(() => {
        const row = this.row(owner, id),
          digest = hash(
            JSON.stringify([id, body.decision, body.version, hash(body.nonce)]),
          );
        const prior = this.db
          .query<{ digest: string; result: string }, [string, string]>(
            "SELECT digest,result FROM demo_decisions WHERE owner=? AND request=?",
          )
          .get(owner, body.request_id);
        if (prior) {
          if (prior.digest !== digest)
            throw new LocalError(
              "Request ID conflicts with an earlier decision.",
              409,
            );
          return JSON.parse(prior.result) as ReturnType<
            DemoAppointments["get"]
          >;
        }
        if (row.version !== body.version)
          throw new LocalError("Task changed. Refresh and review again.", 409);
        if (row.state === "EXPIRED")
          throw new LocalError("Approval expired. Review again.", 409);
        if (
          row.state !== "APPROVAL_PENDING" ||
          !row.nonce_hash ||
          !row.preview ||
          !timingSafeEqual(
            Buffer.from(hash(body.nonce)),
            Buffer.from(row.nonce_hash),
          )
        )
          throw new LocalError("A current exact approval is required.", 403);
        const quote = JSON.parse(row.preview) as Quote;
        const { hash: expected, ...fields } = quote;
        if (hash(JSON.stringify(fields)) !== expected)
          throw new LocalError(
            "Stored approval integrity failed. No booking made.",
            503,
          );
        if (body.decision === "reject")
          this.change(row, "REJECTED", "approval.rejected");
        else {
          this.audit(row, "approval.granted");
          const reference = `MOCK-SAATHI-${randomUUID().replaceAll("-", "").toUpperCase()}`;
          const available = this.options(row.date).slots.some(
            (slot) => slot.id === quote.slot_id,
          );
          const inserted = available
            ? this.db
                .query("INSERT OR IGNORE INTO demo_bookings VALUES(?,?,?,?)")
                .run(id, row.date, quote.slot_id, reference).changes
            : 0;
          if (!inserted) this.change(row, "UNAVAILABLE", "slot.unavailable");
          else {
            const summary =
              row.locale === "hi-IN"
                ? "डेमो बुकिंग की पुष्टि हुई। यह वास्तविक अपॉइंटमेंट नहीं है।"
                : row.locale === "ta-IN"
                  ? "டெமோ முன்பதிவு உறுதி செய்யப்பட்டது. இது உண்மையான சந்திப்பு அல்ல."
                  : "Demo booking confirmed. This is not a real appointment.";
            this.db.query("UPDATE demo_tasks SET receipt=? WHERE id=?").run(
              JSON.stringify({
                mode: "mock",
                reference,
                confirmed_at: this.now(),
                summary,
                quote,
              }),
              id,
            );
            this.change(row, "COMPLETED", "mock.booking_confirmed");
          }
        }
        const result = this.view(this.row(owner, id));
        this.db
          .query("INSERT INTO demo_decisions VALUES(?,?,?,?,?)")
          .run(owner, body.request_id, id, digest, JSON.stringify(result));
        return result;
      })
      .immediate();
  }
  cancel(owner: string, id: string, input: unknown) {
    const body = parse(z.object({ version }).strict(), { version: input });
    this.expire(owner, id);
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (row.state === "CANCELLED") return this.view(row);
        if (row.state === "COMPLETED")
          throw new LocalError(
            "A completed mock receipt cannot be cancelled. No real appointment exists.",
            409,
          );
        if (row.version !== body.version)
          throw new LocalError("Task changed. Refresh first.", 409);
        if (terminal.has(row.state))
          throw new LocalError("This demo task is terminal.", 409);
        this.change(row, "CANCELLED", "task.cancelled");
        return this.view(this.row(owner, id));
      })
      .immediate();
  }
}

export type { State as DemoAppointmentState };
