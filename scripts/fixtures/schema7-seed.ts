// Invoked only by generate-schema7-fixture.py with an isolated historical module.
import { Database } from "bun:sqlite";
import { copyFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [source, path, output] = process.argv.slice(2);
if (!source || !path || !output)
  throw new Error("Missing synthetic fixture paths");
const { SelfHostedStore } = await import(
  pathToFileURL(`${source}/store.ts`).href
);
const { selfHostedConfig } = await import(
  pathToFileURL(`${source}/config.ts`).href
);
const now = Date.parse("2026-10-29T01:00:00Z");
Date.now = () => now;
const roles = selfHostedConfig({}).roles;
const store = new SelfHostedStore(path, { now: () => now });
const a = store.createSession(),
  b = store.createSession();
const thread = store.createThread(a.owner, "saathi");
const run = store.beginRun(
  a.owner,
  thread.id,
  "completed",
  "Synthetic cited question",
);
const evidence = {
  sources: [
    { title: "Synthetic source", url: "https://example.com/synthetic" },
  ],
  searchedAt: new Date(now).toISOString(),
  searchCalls: 1,
};
store.completeRun(a.owner, run.id, "Synthetic cited answer", evidence);
store.saveMemory(a.owner, "Synthetic reviewed preference A", true);
const otherThread = store.createThread(b.owner, "saathi");
const otherRun = store.beginRun(
  b.owner,
  otherThread.id,
  "other-completed",
  "Synthetic other question",
);
store.completeRun(b.owner, otherRun.id, "Synthetic other answer");
store.saveMemory(b.owner, "Synthetic reviewed preference B", true);
const task = store.appointments.create(a.owner, {
  request_id: "mock-booking",
  date: "2026-10-30",
  locale: "en-IN",
});
const quote = store.appointments.preview(a.owner, task.id, {
  slot_id: "10:00",
  version: task.version,
});
const approval = {
  request_id: "mock-approval",
  decision: "approve",
  version: quote.task.version,
  nonce: quote.nonce,
};
const booking = store.appointments.decide(a.owner, task.id, approval);
const plan = store.plans.begin(
  a.owner,
  {
    request_id: "read-draft",
    goal: "Synthetic demo slots",
    locale: "en-IN",
    date: "2026-10-30",
  },
  roles,
);
store.plans.complete(a.owner, plan.id, {
  goal: plan.input.goal,
  status: "ready",
  question: null,
  unavailable_reason: null,
  steps: [
    {
      id: "s1",
      description: "Synthetic mock lookup",
      prerequisites: [],
      tool: "demo.clinic.options",
      risk: "READ",
      approval_required: false,
      arguments: { date: "2026-10-30" },
      expected_output: "Mock slots",
      timeout_ms: 1000,
      compensation: "none",
    },
  ],
});
const read = store.planReads.run(a.owner, plan.id);
const pendingThread = store.createThread(a.owner, "saathi");
const pendingRun = store.beginRun(
  a.owner,
  pendingThread.id,
  "pending",
  "Synthetic interrupted question",
);
const pendingPlan = store.plans.begin(
  b.owner,
  {
    request_id: "interrupted-draft",
    goal: "Synthetic pending plan",
    locale: "ta-IN",
    date: "2026-10-30",
  },
  roles,
);
store.close();
const db = new Database(path, { readonly: true });
if (
  (db.query("SELECT value FROM version").get() as { value: number }).value !== 7
)
  throw new Error("Historical source did not create schema7");
db.close();
// Tokens are not needed for owner-qualified migration assertions. Never export them.
await Bun.write(
  output,
  JSON.stringify(
    {
      now,
      a: { owner: a.owner },
      b: { owner: b.owner },
      thread: { id: thread.id },
      run: { id: run.id },
      evidence,
      booking,
      approval,
      plan: { id: plan.id, input: plan.input },
      read,
      pendingThread: { id: pendingThread.id },
      pendingRun: { id: pendingRun.id },
      pendingPlan: { id: pendingPlan.id, input: pendingPlan.input },
      roles,
    },
    null,
    2,
  ) + "\n",
);
const currentModule = process.argv[5];
if (currentModule) {
  const trial = `${path}.upgrade-review`,
    restore = `${path}.restore-review`;
  copyFileSync(path, trial);
  copyFileSync(path, restore);
  const { SelfHostedStore: CurrentStore } = await import(
    pathToFileURL(currentModule).href
  );
  const upgraded = new CurrentStore(trial, { now: () => now });
  upgraded.close();
  let refused = false;
  try {
    const old = new SelfHostedStore(trial);
    old.close();
  } catch (error) {
    refused =
      error instanceof Error &&
      error.message === "Unsupported local schema version.";
  }
  if (!refused)
    throw new Error("Historical binary did not refuse upgraded schema");
  const restored = new SelfHostedStore(restore, { now: () => now });
  if (
    restored.appointments.get(a.owner, booking.id).receipt.reference !==
    booking.receipt.reference
  )
    throw new Error("Synthetic pre-upgrade restore lost mock receipt");
  restored.close();
  const check = new Database(trial, { readonly: true });
  if (
    (check.query("SELECT value FROM version").get() as { value: number })
      .value !== 15
  )
    throw new Error("Historical refusal changed current version");
  check.close();
  console.log(
    "Historical7 source refused upgraded15; separate closed pre-upgrade copy reopened with historical code.",
  );
}
