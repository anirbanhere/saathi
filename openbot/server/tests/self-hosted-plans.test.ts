import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { selfHostedConfig } from "../src/self-hosted/config";
import { type PlanInput, validatePlan } from "../src/self-hosted/plan-contract";
import { createPlanner } from "../src/self-hosted/planner";
import { SelfHostedStore } from "../src/self-hosted/store";

const stores: SelfHostedStore[] = [],
  folders: string[] = [];
const roles = selfHostedConfig({}).roles;
const input = {
  request_id: "plan-1",
  goal: "Find demo dental slots",
  locale: "en-IN",
  date: "2026-10-30",
} satisfies PlanInput;
const proposed = () => ({
  goal: input.goal,
  status: "ready",
  question: null,
  unavailable_reason: null,
  steps: [
    {
      id: "s1",
      description: "Look up controlled demo slots",
      prerequisites: [],
      tool: "demo.clinic.options",
      risk: "READ",
      approval_required: false,
      arguments: { date: input.date },
      expected_output: "Simulated available slots",
      timeout_ms: 1000,
      compensation: "none",
    },
  ],
});
function world(limits = { global: 5, owner: 3 }) {
  const folder = mkdtempSync(join(tmpdir(), "saathi-plans-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite"),
    store = new SelfHostedStore(path, { limits });
  stores.push(store);
  return { store, path, a: store.createSession(), b: store.createSession() };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-plans-")
    )
      throw new Error("Unsafe test cleanup path");
    rmSync(folder, { recursive: true, force: true });
  }
});
test("planning pins roles, deduplicates request identity, isolates owners and never replays on reopen", () => {
  const { store, path, a, b } = world();
  const task = store.plans.begin(a.owner, input, roles);
  expect(task.fresh).toBe(true);
  expect(task.state).toBe("PLANNING");
  expect(task.roles.revision).toBe(roles.revision);
  const changed = selfHostedConfig({
    SAATHI_REASONING_MODEL: "openrouter:some/model:free",
  }).roles;
  const duplicate = store.plans.begin(a.owner, input, changed);
  expect(duplicate.id).toBe(task.id);
  expect(duplicate.roles.reasoning.id).toBe(roles.reasoning.id);
  expect(duplicate.fresh).toBe(false);
  expect(() =>
    store.plans.begin(a.owner, { ...input, goal: "Changed" }, roles),
  ).toThrow("conflicts");
  expect(() => store.plans.get(b.owner, task.id)).toThrow("not found");
  expect(() => store.plans.cancel(b.owner, task.id)).toThrow("not found");
  expect(store.plans.list(b.owner)).toEqual([]);
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(reopened.plans.get(a.owner, task.id).state).toBe("INTERRUPTED");
  expect(reopened.plans.begin(a.owner, input, changed).fresh).toBe(false);
  expect(reopened.plans.get(a.owner, task.id).roles).toEqual(roles);
  const db = new Database(path);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM inference_usage").get()
      ?.n,
  ).toBe(1);
  db.close();
});
test("planner and chat share pending guards and durable attempt allowance; cancellation suppresses late completion", () => {
  const { store, a, path } = world({ global: 3, owner: 2 });
  const thread = store.createThread(a.owner, "saathi");
  const chat = store.beginRun(a.owner, thread.id, "chat-1", "Synthetic chat");
  expect(() => store.plans.begin(a.owner, input, roles)).toThrow("running");
  store.failRun(a.owner, chat.id);
  const task = store.plans.begin(a.owner, input, roles);
  expect(() =>
    store.beginRun(a.owner, thread.id, "chat-2", "Another chat"),
  ).toThrow("running");
  expect(store.plans.cancel(a.owner, task.id).state).toBe("CANCELLED");
  expect(store.plans.cancel(a.owner, task.id).state).toBe("CANCELLED");
  expect(() =>
    store.plans.begin(
      a.owner,
      { ...input, request_id: "while-cancelling" },
      roles,
    ),
  ).toThrow("running");
  store.plans.fail(a.owner, task.id);
  expect(store.plans.get(a.owner, task.id).state).toBe("CANCELLED");
  expect(() =>
    store.plans.begin(a.owner, { ...input, request_id: "plan-2" }, roles),
  ).toThrow("allowance");
  const db = new Database(path);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM inference_usage").get()
      ?.n,
  ).toBe(2);
  db.close();
});
test("v5 upgrade preserves history, preferences, mock bookings and attempt usage", () => {
  const { store, path, a } = world();
  const thread = store.createThread(a.owner, "saathi"),
    run = store.beginRun(a.owner, thread.id, "before", "Synthetic");
  store.completeRun(a.owner, run.id, "Saved answer");
  store.saveMemory(a.owner, "Synthetic preference", true);
  const date = store.appointments.options().max_date;
  const booking = store.appointments.create(a.owner, {
    request_id: "mock",
    date,
    locale: "en-IN",
  });
  store.close();
  const db = new Database(path);
  db.exec(
    "DROP TABLE plan_events; DROP TABLE task_plans; UPDATE version SET value=5",
  );
  db.close();
  const migrated = new SelfHostedStore(path);
  stores.push(migrated);
  expect(migrated.thread(a.owner, thread.id).messages).toHaveLength(2);
  expect(migrated.memories(a.owner)).toHaveLength(1);
  expect(migrated.appointments.get(a.owner, booking.id).date).toBe(date);
  expect(migrated.plans.list(a.owner)).toEqual([]);
  const verify = new Database(path);
  try {
    expect(
      verify.query<{ value: number }, []>("SELECT value FROM version").get()
        ?.value,
    ).toBe(13);
    expect(
      verify
        .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
        .get()?.n,
    ).toBe(1);
  } finally {
    verify.close();
  }
});

test("strict plans reject model-invented dates, capabilities, writes, extra fields and invalid dependencies", () => {
  expect(validatePlan(input, proposed()).steps).toHaveLength(1);
  const bad = [
    { ...proposed(), goal: "A different goal" },
    { ...proposed(), grant: "pay" },
    { ...proposed(), status: "needs_clarification", question: "Which date?" },
    { ...proposed(), steps: [{ ...proposed().steps[0], tool: "pay.bill" }] },
    { ...proposed(), steps: [{ ...proposed().steps[0], risk: "BOOK" }] },
    {
      ...proposed(),
      steps: [{ ...proposed().steps[0], arguments: { date: "2026-10-31" } }],
    },
    {
      ...proposed(),
      steps: [{ ...proposed().steps[0], prerequisites: ["s2"] }],
    },
    { ...proposed(), steps: [{ ...proposed().steps[0], timeout_ms: 60000 }] },
  ];
  for (const plan of bad) expect(() => validatePlan(input, plan)).toThrow();
  expect(() => validatePlan({ ...input, date: undefined }, proposed())).toThrow(
    "unconfirmed date",
  );
});

test("planner uses the saved reasoning role and strict JSON, without native web tools or chat model switching", async () => {
  const config = selfHostedConfig({
    SAATHI_ENABLE_META: "true",
    META_API_KEY: "synthetic-meta",
    OPENROUTER_API_KEY: "synthetic-router",
    SAATHI_META_WEB_SEARCH: "true",
    SAATHI_REASONING_MODEL: "meta:muse-spark-1.3",
  });
  const { store, a } = world();
  const task = store.plans.begin(a.owner, input, config.roles);
  let calls = 0;
  const planner = await createPlanner(
    { ...config, roles },
    {
      fetch: async (url, init) => {
        calls++;
        expect(url).toBe("https://api.meta.ai/v1/chat/completions");
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe(task.roles.reasoning.model);
        expect(body.tools).toBeUndefined();
        expect(body.messages[0].content).toContain(
          "Return only one JSON object",
        );
        expect(body.messages.at(-1).content).toContain(input.goal);
        expect((init.headers as Record<string, string>).Authorization).toBe(
          "Bearer synthetic-meta",
        );
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify(proposed()),
              },
            },
          ],
        });
      },
    },
  );
  const plan = await planner(task);
  expect(plan).toEqual(proposed());
  expect(calls).toBe(1);
  expect(store.appointments.list(a.owner)).toEqual([]);
});

test("planning API requires owner/CSRF, saves one proposal and never replays duplicate or changed requests", async () => {
  const { store, a, b } = world();
  let calls = 0;
  const app = createSelfHostedApp({
    store,
    model: "openrouter/free",
    roles,
    answer: async () => "unused",
    planner: async () => {
      calls++;
      return proposed();
    },
  });
  const request = (
    method: string,
    path: string,
    body?: unknown,
    session = a,
    csrf = session.csrf,
  ) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        cookie: `saathi_self_hosted=${session.token}`,
        "x-saathi-csrf": csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  expect((await app.request("http://localhost/api/task-plans")).status).toBe(
    401,
  );
  expect(
    (await request("POST", "/api/task-plans", input, a, "wrong")).status,
  ).toBe(403);
  expect(
    (await request("POST", "/api/task-plans", { ...input, roles })).status,
  ).toBe(422);
  const first = await request("POST", "/api/task-plans", input);
  expect(first.status).toBe(201);
  const task = await first.json();
  expect(task.state).toBe("DRAFT_READY");
  expect(task.mode).toBe("draft_only");
  expect((await request("POST", "/api/task-plans", input)).status).toBe(200);
  expect(
    (await request("POST", "/api/task-plans", { ...input, goal: "Changed" }))
      .status,
  ).toBe(409);
  expect(calls).toBe(1);
  expect(
    (await request("GET", `/api/task-plans/${task.id}`, undefined, b)).status,
  ).toBe(404);
  expect(
    (await request("POST", `/api/task-plans/${task.id}/cancel`, {}, b)).status,
  ).toBe(404);
  expect(
    (
      await request("POST", `/api/task-plans/${task.id}/cancel`, {
        approve: true,
      })
    ).status,
  ).toBe(422);
  expect(
    (await request("POST", `/api/task-plans/${task.id}/cancel`, {})).status,
  ).toBe(200);
  expect(
    (await (await request("GET", `/api/task-plans/${task.id}`)).json()).state,
  ).toBe("CANCELLED");
  expect(store.appointments.list(a.owner)).toEqual([]);
});

test("duplicate in-flight planning and cancellation suppress late output with one charged attempt", async () => {
  const { store, a, path } = world();
  let finish: ((value: ReturnType<typeof proposed>) => void) | undefined,
    calls = 0;
  const pending = new Promise<ReturnType<typeof proposed>>((resolve) => {
    finish = resolve;
  });
  const app = createSelfHostedApp({
    store,
    model: "openrouter/free",
    roles,
    answer: async () => "unused",
    planner: async () => {
      calls++;
      return await pending;
    },
  });
  const request = (url: string, body: unknown) =>
    app.request(`http://localhost${url}`, {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        cookie: `saathi_self_hosted=${a.token}`,
        "x-saathi-csrf": a.csrf,
      },
      body: JSON.stringify(body),
    });
  const first = request("/api/task-plans", input);
  // The first request reaches the deferred provider before issuing a concurrent retry.
  for (let i = 0; i < 20 && !calls; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(calls).toBe(1);
  const duplicate = await request("/api/task-plans", input),
    task = await duplicate.json();
  expect(task.state).toBe("PLANNING");
  expect((await request(`/api/task-plans/${task.id}/cancel`, {})).status).toBe(
    200,
  );
  expect(
    (
      await request("/api/task-plans", {
        ...input,
        request_id: "while-cancelling",
      })
    ).status,
  ).toBe(409);
  finish?.(proposed());
  expect((await (await first).json()).state).toBe("CANCELLED");
  expect(store.plans.get(a.owner, task.id).plan).toBeNull();
  expect(calls).toBe(1);
  const db = new Database(path);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM inference_usage").get()
      ?.n,
  ).toBe(1);
  db.close();
});

test("unsafe planner output fails durably, is charged once, and never becomes a mock booking", async () => {
  const { store, a } = world({ global: 1, owner: 1 });
  let calls = 0;
  const app = createSelfHostedApp({
    store,
    model: "openrouter/free",
    roles,
    answer: async () => "unused",
    planner: async () => {
      calls++;
      return {
        ...proposed(),
        steps: [
          {
            ...proposed().steps[0],
            tool: "pay.bill",
            secret: "synthetic-private-provider-value",
          },
        ],
      };
    },
  });
  const request = (body: unknown) =>
    app.request("http://localhost/api/task-plans", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        cookie: `saathi_self_hosted=${a.token}`,
        "x-saathi-csrf": a.csrf,
      },
      body: JSON.stringify(body),
    });
  const failed = await request(input);
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain("synthetic-private-provider-value");
  expect(store.plans.list(a.owner)[0].state).toBe("FAILED");
  expect(store.plans.list(a.owner)[0].plan).toBeNull();
  expect((await request(input)).status).toBe(200);
  expect(calls).toBe(1);
  expect((await request({ ...input, request_id: "new-attempt" })).status).toBe(
    429,
  );
  expect(store.appointments.list(a.owner)).toEqual([]);
});

test("actual planner adapter refuses fenced or malformed JSON without retry or tool execution", async () => {
  const { store, a } = world();
  const config = selfHostedConfig({ OPENROUTER_API_KEY: "synthetic-router" });
  for (const [index, content] of ["```json\n{}\n```", "{invalid"].entries()) {
    const task = store.plans.begin(
      a.owner,
      { ...input, request_id: `invalid-${index}` },
      config.roles,
    );
    let calls = 0;
    const planner = await createPlanner(config, {
      fetch: async () => {
        calls++;
        return Response.json({
          choices: [
            { finish_reason: "stop", message: { role: "assistant", content } },
          ],
        });
      },
    });
    await expect(planner(task)).rejects.toThrow("strict JSON");
    expect(calls).toBe(1);
    store.plans.fail(a.owner, task.id);
  }
  expect(store.appointments.list(a.owner)).toEqual([]);
});

test("new tasks choose only eligible reasoning models, pin independent roles and recover duplicates without catalogue IO", async () => {
  const { store, a, path } = world();
  let checks = 0,
    calls = 0,
    offline = false;
  const app = createSelfHostedApp({
    store,
    roles,
    model: "openrouter/free",
    answer: async () => "unused",
    models: async () => {
      checks++;
      if (offline) throw new Error("Catalogue offline");
      return {
        models: [
          {
            id: "meta:muse-spark-1.3",
            provider: "meta",
            model: "muse-spark-1.3",
            name: "Meta",
            inputPerMillion: 0,
            outputPerMillion: 0,
          },
        ],
        defaultModel: "meta:muse-spark-1.3",
        allowPaid: false,
        metaEnabled: true,
        maxInputPrice: 0,
        maxOutputPrice: 0,
        checkedAt: 0,
        issues: [],
      };
    },
    planner: async (task) => {
      calls++;
      expect(task.roles.reasoning.id).toBe("meta:muse-spark-1.3");
      expect(task.roles.conversation).toEqual(roles.conversation);
      expect(task.roles.stt).toEqual(roles.stt);
      expect(task.roles.revision).not.toBe(roles.revision);
      return proposed();
    },
  });
  const request = (body: unknown) =>
    app.request("http://localhost/api/task-plans", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        cookie: `saathi_self_hosted=${a.token}`,
        "x-saathi-csrf": a.csrf,
      },
      body: JSON.stringify(body),
    });
  expect(
    (await request({ ...input, reasoning_model: "openrouter:paid/unknown" }))
      .status,
  ).toBe(403);
  const body = { ...input, reasoning_model: "meta:muse-spark-1.3" };
  expect((await request(body)).status).toBe(201);
  offline = true;
  expect((await request(body)).status).toBe(200);
  expect(
    (await request({ ...body, reasoning_model: "openrouter:openrouter/free" }))
      .status,
  ).toBe(409);
  expect(checks).toBe(2);
  expect(calls).toBe(1);
  expect(roles.reasoning.id).toBe("openrouter:openrouter/free");
  const db = new Database(path);
  expect(
    db.query<{ n: number }, []>("SELECT count(*) n FROM inference_usage").get()
      ?.n,
  ).toBe(1);
  db.close();
});
