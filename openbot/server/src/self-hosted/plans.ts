import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { LocalError } from "./errors";
import {
  type PlanInput,
  planInput,
  type TaskPlan,
  validatePlan,
} from "./plan-contract";
import { savedPlanRead } from "./plan-reads";
import type { ProviderRoles } from "./roles";

type State =
  | "PLANNING"
  | "DRAFT_READY"
  | "NEEDS_CLARIFICATION"
  | "UNAVAILABLE"
  | "FAILED"
  | "INTERRUPTED"
  | "CANCELLED";
type Row = {
  id: string;
  owner: string;
  request: string;
  digest: string;
  input: string;
  roles: string;
  state: State;
  pending: number;
  plan: string | null;
  created: number;
  updated: number;
};
export function migratePlans(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_plans(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES owners(id),request TEXT NOT NULL,digest TEXT NOT NULL,input TEXT NOT NULL,roles TEXT NOT NULL,state TEXT NOT NULL,pending INTEGER NOT NULL,plan TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(owner,request));
    CREATE INDEX IF NOT EXISTS task_plans_owner ON task_plans(owner);
    CREATE TABLE IF NOT EXISTS plan_events(task TEXT NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,seq INTEGER NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(task,seq));`);
}
export class TaskPlans {
  constructor(
    private db: Database,
    private hooks: {
      reserve: (owner: string, id: string) => void;
      busy: (owner: string) => boolean;
      now: () => number;
    },
  ) {}
  private row(owner: string, id: string) {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM task_plans WHERE id=? AND owner=?",
      )
      .get(id, owner);
    if (!row) throw new LocalError("Task plan not found.", 404);
    return row;
  }
  private event(id: string, event: string) {
    this.db
      .query(
        "INSERT INTO plan_events SELECT ?,COALESCE(MAX(seq),-1)+1,?,? FROM plan_events WHERE task=?",
      )
      .run(id, event, this.hooks.now(), id);
  }
  private view(row: Row) {
    return {
      id: row.id,
      mode: "draft_only" as const,
      input: JSON.parse(row.input) as PlanInput,
      roles: JSON.parse(row.roles) as ProviderRoles,
      state: row.state,
      plan: row.plan ? (JSON.parse(row.plan) as TaskPlan) : null,
      read_result: savedPlanRead(this.db, row.id),
      created: row.created,
      updated: row.updated,
      events: this.db
        .query<{ event: string; at: number }, [string]>(
          "SELECT event,at FROM plan_events WHERE task=? ORDER BY seq",
        )
        .all(row.id),
    };
  }
  get(owner: string, id: string) {
    return this.view(this.row(owner, id));
  }
  list(owner: string) {
    return this.db
      .query<Row, [string]>(
        "SELECT * FROM task_plans WHERE owner=? ORDER BY created DESC,id LIMIT 30",
      )
      .all(owner)
      .map((row) => this.view(row));
  }
  previous(owner: string, request: string) {
    const row = this.db
      .query<Row, [string, string]>(
        "SELECT * FROM task_plans WHERE owner=? AND request=?",
      )
      .get(owner, request);
    return row ? this.view(row) : null;
  }
  begin(owner: string, raw: unknown, roles: ProviderRoles) {
    const parsed = planInput.safeParse(raw);
    if (!parsed.success)
      throw new LocalError("Invalid task goal, locale or exact date.");
    const input = parsed.data,
      encoded = JSON.stringify(input),
      digest = createHash("sha256").update(encoded).digest("hex");
    return this.db
      .transaction(() => {
        const prior = this.db
          .query<Row, [string, string]>(
            "SELECT * FROM task_plans WHERE owner=? AND request=?",
          )
          .get(owner, input.request_id);
        if (prior) {
          if (prior.digest !== digest)
            throw new LocalError(
              "Request ID conflicts with an earlier task plan.",
              409,
            );
          return { ...this.view(prior), fresh: false };
        }
        if (this.hooks.busy(owner))
          throw new LocalError(
            "An inference is already running in this workspace.",
            409,
          );
        if (this.list(owner).length >= 30)
          throw new LocalError("Task plan budget reached.", 429);
        const id = randomUUID(),
          now = this.hooks.now();
        this.hooks.reserve(owner, id);
        this.db
          .query(
            "INSERT INTO task_plans VALUES(?,?,?,?,?,?,'PLANNING',1,NULL,?,?)",
          )
          .run(
            id,
            owner,
            input.request_id,
            digest,
            encoded,
            JSON.stringify(roles),
            now,
            now,
          );
        this.event(id, "task.created");
        return { ...this.get(owner, id), fresh: true };
      })
      .immediate();
  }
  complete(owner: string, id: string, raw: unknown) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (row.state === "CANCELLED") {
          this.db.query("UPDATE task_plans SET pending=0 WHERE id=?").run(id);
          return this.view(row);
        }
        if (row.state !== "PLANNING")
          throw new LocalError(
            "This plan cannot be completed or replayed.",
            409,
          );
        const plan = validatePlan(JSON.parse(row.input) as PlanInput, raw),
          state: State =
            plan.status === "ready"
              ? "DRAFT_READY"
              : plan.status === "needs_clarification"
                ? "NEEDS_CLARIFICATION"
                : "UNAVAILABLE";
        this.db
          .query(
            "UPDATE task_plans SET state=?,pending=0,plan=?,updated=? WHERE id=? AND owner=?",
          )
          .run(state, JSON.stringify(plan), this.hooks.now(), id, owner);
        this.event(id, "task.planned");
        return this.get(owner, id);
      })
      .immediate();
  }
  fail(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (row.state === "CANCELLED") {
          this.db.query("UPDATE task_plans SET pending=0 WHERE id=?").run(id);
          return this.view(row);
        }
        if (row.state !== "PLANNING") return this.view(row);
        this.db
          .query(
            "UPDATE task_plans SET state='FAILED',pending=0,updated=? WHERE id=?",
          )
          .run(this.hooks.now(), id);
        this.event(id, "task.failed");
        return this.get(owner, id);
      })
      .immediate();
  }
  cancel(owner: string, id: string) {
    return this.db
      .transaction(() => {
        const row = this.row(owner, id);
        if (row.state === "CANCELLED") return this.view(row);
        if (["FAILED", "INTERRUPTED"].includes(row.state))
          throw new LocalError("This task is already terminal.", 409);
        this.db
          .query("UPDATE task_plans SET state='CANCELLED',updated=? WHERE id=?")
          .run(this.hooks.now(), id);
        this.event(id, "task.cancelled");
        return this.get(owner, id);
      })
      .immediate();
  }
  recover() {
    this.db
      .transaction(() => {
        const rows = this.db
          .query<Row, []>("SELECT * FROM task_plans WHERE state='PLANNING'")
          .all();
        for (const row of rows) {
          this.db
            .query(
              "UPDATE task_plans SET state='INTERRUPTED',pending=0,updated=? WHERE id=?",
            )
            .run(this.hooks.now(), row.id);
          this.event(row.id, "task.interrupted");
        }
        this.db.exec("UPDATE task_plans SET pending=0 WHERE state='CANCELLED'");
      })
      .immediate();
  }
}

export type { State as TaskPlanState };
