import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { selfHostedConfig } from "../../openbot/server/src/self-hosted/config";
import { SelfHostedStore } from "../../openbot/server/src/self-hosted/store";

const root = resolve(import.meta.dir, "../.."),
  build = join(root, "artifacts/public-build");
const folder = mkdtempSync(join(tmpdir(), "saathi-bundle-"));
if (
  dirname(resolve(folder)) !== resolve(tmpdir()) ||
  !basename(folder).startsWith("saathi-bundle-")
)
  throw new Error("Unsafe test cleanup target");
// Seed only an owned synthetic proposal; the actual packaged HTTP service executes its reads.
const seed = new SelfHostedStore(join(folder, "state.sqlite"));
const seedSession = seed.createSession();
const seedDate = new Date(Date.now() + 19800000 + 86400000)
  .toISOString()
  .slice(0, 10);
const seedTask = seed.plans.begin(
  seedSession.owner,
  {
    request_id: "packed-ready",
    goal: "Synthetic mock slot read",
    locale: "en-IN",
    date: seedDate,
  },
  selfHostedConfig({}).roles,
);
seed.plans.complete(seedSession.owner, seedTask.id, {
  goal: seedTask.input.goal,
  status: "ready",
  question: null,
  unavailable_reason: null,
  steps: [
    {
      id: "s1",
      description: "Read mock slots",
      prerequisites: [],
      tool: "demo.clinic.options",
      risk: "READ",
      approval_required: false,
      arguments: { date: seedDate },
      expected_output: "Mock availability",
      timeout_ms: 1000,
      compensation: "none",
    },
  ],
});
seed.close();
const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(),
});
const port = probe.port;
assert(port);
probe.stop(true);
const base = `http://127.0.0.1:${port}`,
  origin = "https://demo.example.test";
const inheritedEnv = { ...process.env };
for (const name of Object.keys(inheritedEnv))
  if (/^SAATHI_(REASONING|CONVERSATION|EXTRACTION|STT|TTS)_/.test(name))
    delete inheritedEnv[name];
const child = Bun.spawn([process.execPath, join(build, "app.js")], {
  cwd: build,
  stdout: "ignore",
  stderr: "pipe",
  env: {
    ...inheritedEnv,
    META_API_KEY: "",
    MODEL_API_KEY: "",
    OPENROUTER_API_KEY: "",
    OPENAI_API_KEY: "",
    INTELLIGENCE_API_KEY: "",
    CPK_INTELLIGENCE_API_KEY: "",
    SAATHI_ENABLE_META: "false",
    SAATHI_ALLOW_PAID_MODELS: "false",
    SAATHI_LOCAL_MEDIA_CONTROLS: "false",
    SAATHI_LOCAL_MEDIA_UPLOADS: "false",
    SAATHI_LOCAL_FIXTURE_SPEECH: "false",
    BOT_MODEL: "openrouter/free",
    SAATHI_PUBLIC_ORIGIN: origin,
    SAATHI_DATABASE_PATH: join(folder, "state.sqlite"),
    SAATHI_TENANT_PATH: join(build, "examples/saathi"),
    SAATHI_WEB_ROOT: join(build, "saathi-web"),
    SAATHI_PORT: String(port),
  },
});
const request = (path: string, init: RequestInit = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      Host: "demo.example.test",
      Origin: origin,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(5000),
  });
const sessionCookie = (response: Response) => {
  const value = response.headers.get("set-cookie")?.split(";")[0];
  assert(value);
  return value;
};
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try {
      ready = (await request("/health")).ok;
    } catch {}
    if (ready) break;
    await Bun.sleep(125);
  }
  assert(ready, "Bundle did not start");
  const health = await (await request("/health")).json();
  assert.equal(health.public_demo, true);
  assert.equal(health.local_media_controls, false);
  assert.equal(health.local_media_uploads, false);
  assert.equal(health.fixture_speech, false);
  assert.equal(health.speech, false);
  assert.equal(
    (
      await request("/api/media", {
        headers: { Cookie: `saathi_self_hosted=${seedSession.token}` },
      })
    ).status,
    404,
  );
  const readAuth = {
    Cookie: `saathi_self_hosted=${seedSession.token}`,
    "X-Saathi-CSRF": seedSession.csrf,
  };
  assert.equal(
    (
      await request("/api/media/upload", {
        method: "POST",
        headers: readAuth,
        body: "{}",
      })
    ).status,
    404,
  );
  const readPath = `/api/task-plans/${seedTask.id}/run-readonly`;
  const mediaPath = "/api/media/00000000-0000-4000-8000-000000000000";
  assert.equal(
    (await request("/api/fixture-stt", { headers: readAuth })).status,
    404,
  );
  assert.equal(
    (
      await request("/api/fixture-stt/00000000-0000-4000-8000-000000000000", {
        headers: readAuth,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`${mediaPath}/fixture-stt`, {
        method: "POST",
        headers: readAuth,
        body: JSON.stringify({
          request_id: "public-denied",
          consent_revision: 1,
        }),
      })
    ).status,
    404,
  );
  assert.equal((await request(mediaPath, { headers: readAuth })).status, 404);
  assert.equal(
    (
      await request(`${mediaPath}/revoke-processing`, {
        method: "POST",
        headers: readAuth,
        body: "{}",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(mediaPath, {
        method: "DELETE",
        headers: readAuth,
        body: "{}",
      })
    ).status,
    404,
  );
  const read = await (
    await request(readPath, { method: "POST", headers: readAuth, body: "{}" })
  ).json();
  assert.equal(read.mode, "read_only");
  assert.equal(read.status, "completed");
  assert.equal(read.results[0].evidence_mode, "mock");
  assert.equal(read.results[0].output.date, seedDate);
  assert.deepEqual(
    await (
      await request(readPath, { method: "POST", headers: readAuth, body: "{}" })
    ).json(),
    read,
  );
  assert.deepEqual(health.daily_limits, { global: 20, owner: 5 });
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("strict-transport-security"), "max-age=86400");
  assert((await page.text()).includes("Reply model"));
  assert.equal((await request("/assets/app.js")).status, 200);
  assert.equal((await request("/assets/appointments.js")).status, 200);
  assert.equal((await request("/assets/plans.js")).status, 200);
  assert.equal((await request("/assets/media.js")).status, 200);
  assert.equal((await request("/assets/upload.js")).status, 200);
  const session = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(session.status, 201);
  assert(session.headers.get("set-cookie")?.includes("Secure"));
  const cookie = sessionCookie(session),
    data = await session.json();
  const thread = await request("/api/threads", {
    method: "POST",
    headers: { Cookie: cookie, "X-Saathi-CSRF": data.csrf },
    body: JSON.stringify({ agent: "saathi" }),
  });
  assert.equal(thread.status, 201);
  const { id } = await thread.json();
  const auth = { Cookie: cookie, "X-Saathi-CSRF": data.csrf };
  assert.equal(
    (await request(`/api/task-plans/${seedTask.id}`, { headers: auth })).status,
    404,
  );
  const roles = await (
    await request("/api/provider-roles", { headers: auth })
  ).json();
  assert.equal(roles.conversation.id, "openrouter:openrouter/free");
  assert.equal(roles.stt.status, "disabled");
  assert.equal(roles.liveSpeechEnabled, false);
  assert.equal(roles.publicAudioEnabled, false);
  assert.deepEqual(
    await (await request("/api/task-plans", { headers: auth })).json(),
    [],
  );
  const draftRequest = {
    request_id: "packed-plan",
    goal: "Synthetic demo slot proposal",
    locale: "en-IN",
  };
  assert.equal(
    (
      await request("/api/task-plans", {
        method: "POST",
        headers: auth,
        body: JSON.stringify(draftRequest),
      })
    ).status,
    502,
  );
  const failedPlans = await (
    await request("/api/task-plans", { headers: auth })
  ).json();
  assert.equal(failedPlans[0].state, "FAILED");
  assert.equal(
    (
      await request("/api/task-plans", {
        method: "POST",
        headers: auth,
        body: JSON.stringify(draftRequest),
      })
    ).status,
    200,
  );
  const options = await (
    await request("/api/demo-appointments/options", { headers: auth })
  ).json();
  const date = new Date(Date.parse(`${options.min_date}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  const task = await (
    await request("/api/demo-appointments", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        request_id: "packed-demo",
        date,
        locale: "en-IN",
      }),
    })
  ).json();
  const review = await (
    await request(`/api/demo-appointments/${task.id}/preview`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ slot_id: "10:00", version: task.version }),
    })
  ).json();
  const decision = {
    request_id: "packed-decision",
    decision: "approve",
    version: review.task.version,
    nonce: review.nonce,
  };
  const booked = await (
    await request(`/api/demo-appointments/${task.id}/decision`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(decision),
    })
  ).json();
  assert.equal(booked.state, "COMPLETED");
  assert(booked.receipt.reference.startsWith("MOCK-"));
  const duplicate = await (
    await request(`/api/demo-appointments/${task.id}/decision`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(decision),
    })
  ).json();
  assert.equal(duplicate.receipt.reference, booked.receipt.reference);
  const other = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ consent: true }),
  });
  assert.equal(
    (
      await request(`/api/threads/${id}`, {
        headers: { Cookie: sessionCookie(other) },
      })
    ).status,
    404,
  );
  child.kill();
  await child.exited;
  const db = new Database(join(folder, "state.sqlite"), { readonly: true });
  try {
    assert.equal(
      (db.query("SELECT count(*) n FROM plan_read_runs").get() as { n: number })
        .n,
      1,
    );
    assert.equal(
      (
        db.query("SELECT count(*) n FROM inference_usage").get() as {
          n: number;
        }
      ).n,
      2,
    );
    assert.equal(
      (db.query("SELECT count(*) n FROM demo_bookings").get() as { n: number })
        .n,
      1,
    );
    assert.equal(
      (db.query("SELECT count(*) n FROM threads").get() as { n: number }).n,
      1,
    );
  } finally {
    db.close();
  }
  console.log(
    "Packed service passed: owned cached mock reads, failed-plan recovery and repeat-safe mock booking. Synthetic seeded attempt plus one missing-key attempt; no outbound model calls.",
  );
} finally {
  child.kill();
  await child.exited;
  rmSync(folder, { recursive: true, force: true });
}
