import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { selfHostedConfig } from "../src/self-hosted/config";
import { LocalFixtureSpeechRuntime } from "../src/self-hosted/fixture-speech-runtime";
import {
  syntheticSpeechFixture,
  type Transcript,
} from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { pcm16ToWav } from "../src/self-hosted/wav";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function world(
  enabled = true,
  publicOrigin?: string,
  options: ConstructorParameters<typeof LocalFixtureSpeechRuntime>[2] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "saathi-fixture-http-")),
    path = join(dir, "state.sqlite"),
    store = new SelfHostedStore(path),
    db = new Database(path);
  let roles = selfHostedConfig({
    SAATHI_STT_PROVIDER: "fixture-a",
    SAATHI_STT_TIMEOUT_MS: "1000",
  }).roles;
  const runtime = new LocalFixtureSpeechRuntime(store, () => roles, options),
    a = store.createSession(),
    b = store.createSession(),
    fixture = syntheticSpeechFixture("ta-IN");
  const media = store.media.admit(a.owner, {
    request_id: "clip",
    audio: fixture.audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: "ta-IN",
  });
  const app = createSelfHostedApp({
    store,
    model: "synthetic:free",
    answer: async () => {
      throw Error("No model expected");
    },
    roles,
    localFixtureSpeech: enabled,
    fixtureSpeech: runtime,
    publicOrigin,
  });
  const base = publicOrigin ?? "http://localhost:8790",
    route = `/api/media/${media.id}/fixture-stt`,
    input = { request_id: "speech", consent_revision: media.consentRevision };
  const headers = (s = a) => ({
    Cookie: `saathi_self_hosted=${s.token}`,
    Origin: base,
    "Content-Type": "application/json",
    "X-Saathi-CSRF": s.csrf,
  });
  const request = (
    body: unknown = input,
    s = a,
    extra: Record<string, string> = {},
  ) =>
    app.request(base + route, {
      method: "POST",
      headers: { ...headers(s), ...extra },
      body: JSON.stringify(body),
    });
  cleanups.push(() => {
    runtime.stop();
    db.close();
    store.close();
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("saathi-fixture-http-")
    )
      throw Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    db,
    path,
    runtime,
    app,
    a,
    b,
    media,
    input,
    request,
    route,
    base,
    headers,
    roles: () => roles,
    change: (p: string) => {
      roles = selfHostedConfig({ SAATHI_STT_PROVIDER: p }).roles;
    },
    fixture,
  };
}
function held() {
  let ready!: () => void,
    release!: (t: Transcript) => void,
    signal: AbortSignal | undefined;
  const started = new Promise<void>((r) => {
      ready = r;
    }),
    result = new Promise<Transcript>((r) => {
      release = r;
    });
  return {
    started,
    release: (t: Transcript) => release(t),
    signal: () => signal,
    options: {
      fixtureProvider: () => ({
        transcribe: async (input: { signal?: AbortSignal }) => {
          signal = input.signal;
          ready();
          return result;
        },
      }),
    },
  };
}
const transcript = (w: ReturnType<typeof world>): Transcript => ({
  text: w.fixture.text,
  language: "ta-IN",
  confidence: null,
  alternatives: [],
  warnings: [],
  source: { mode: "fixture", provider: "fixture-a", model: "synthetic-stt-v1" },
});

test("fixture HTTP opt-in is strict, requires a fixture role and cannot enable public mode", async () => {
  expect(selfHostedConfig({}).localFixtureSpeech).toBe(false);
  expect(
    selfHostedConfig({
      SAATHI_LOCAL_FIXTURE_SPEECH: "true",
      SAATHI_STT_PROVIDER: "fixture-b",
    }).localFixtureSpeech,
  ).toBe(true);
  for (const env of [
    { SAATHI_LOCAL_FIXTURE_SPEECH: "yes" },
    { SAATHI_LOCAL_FIXTURE_SPEECH: "true" },
    {
      SAATHI_LOCAL_FIXTURE_SPEECH: "true",
      SAATHI_STT_PROVIDER: "local-whisper",
      SAATHI_STT_MODEL: "synthetic-model",
    },
    {
      SAATHI_LOCAL_FIXTURE_SPEECH: "true",
      SAATHI_STT_PROVIDER: "fixture-a",
      SAATHI_PUBLIC_ORIGIN: "https://demo.example.test",
    },
  ])
    expect(() => selfHostedConfig(env)).toThrow();
  for (const [enabled, origin] of [
    [false, undefined],
    [true, "https://demo.example.test"],
  ] as const) {
    const w = world(enabled, origin);
    expect((await w.request()).status).toBe(404);
    const health = await (await w.app.request(`${w.base}/health`)).json();
    expect(health.fixture_speech).toBe(false);
    expect(health.speech).toBe(false);
    expect(w.db.query("SELECT * FROM stt_admission_usage").all()).toHaveLength(
      0,
    );
  }
});
test("owned fixture operation completes once, exposes no capabilities and preserves cached identity across role changes", async () => {
  const w = world(),
    response = await w.request();
  expect(response.status).toBe(200);
  const first = await response.json();
  expect(first.mode).toBe("fixture");
  expect(first.state).toBe("completed");
  expect(first.outcome.transcript.text).toBe(w.fixture.text);
  expect(JSON.stringify(first)).not.toMatch(
    /executor|claim_hash|content_hash|"audio"|"owner"/,
  );
  w.change("disabled");
  expect(await (await w.request()).json()).toEqual(first);
  expect(w.db.query("SELECT * FROM stt_admission_usage").all()).toHaveLength(1);
  expect((await w.request({ ...w.input, request_id: "new" })).status).toBe(503);
  w.store.media.revokeProcessing(w.a.owner, w.media.id);
  expect((await (await w.request()).json()).outcome).toBeNull();
});
test("parent guards, strict fields, foreign ownership and missing consent deny before admission", async () => {
  const w = world();
  expect((await w.request(w.input, w.a, { Cookie: "" })).status).toBe(401);
  expect(
    (await w.request(w.input, w.a, { "X-Saathi-CSRF": "wrong" })).status,
  ).toBe(403);
  expect((await w.request(w.input, w.b)).status).toBe(404);
  for (const extra of [
    { owner: w.b.owner },
    { provider: "live" },
    { executor_token: "forged" },
  ])
    expect((await w.request({ ...w.input, ...extra })).status).toBe(422);
  expect((await w.request({ ...w.input, consent_revision: 2 })).status).toBe(
    409,
  );
  const revoked = w.store.media.revokeProcessing(w.a.owner, w.media.id);
  expect(
    (await w.request({ ...w.input, consent_revision: revoked.consentRevision }))
      .status,
  ).toBe(403);
  expect(w.db.query("SELECT * FROM stt_admission_usage").all()).toHaveLength(0);
});
test("shutdown stops admission before reservations, drains actual ignored-abort acknowledgement and closes only once", async () => {
  const h = held(),
    w = world(true, undefined, h.options),
    pending = w.request();
  await h.started;
  const calls: string[] = [],
    server = {
      stop: async (force?: boolean) => {
        expect(force).toBe(false);
        calls.push("server");
      },
    },
    close = () => {
      calls.push("store");
    };
  const first = w.runtime.shutdown(server, close),
    second = w.runtime.shutdown(server, close);
  expect(first).toBe(second);
  expect(h.signal()?.aborted).toBe(true);
  expect(
    (await w.request({ ...w.input, request_id: "after-stop" })).status,
  ).toBe(503);
  expect(w.db.query("SELECT * FROM stt_admission_usage").all()).toHaveLength(1);
  expect(calls).toEqual(["server"]);
  const early = await pending;
  expect(early.status).toBe(200);
  expect((await early.json()).pending).toBe(true);
  h.release(transcript(w));
  await first;
  expect(calls).toEqual(["server", "store"]);
  expect(w.db.query("SELECT pending FROM stt_admissions").get()).toEqual({
    pending: 0,
  });
});
test("expired exact session suppresses HTTP output while private worker can acknowledge without retaining text", async () => {
  const h = held(),
    w = world(true, undefined, h.options),
    pending = w.request();
  await h.started;
  w.db.query("UPDATE sessions SET expires=0 WHERE owner=?").run(w.a.owner);
  h.release(transcript(w));
  expect((await pending).status).toBe(401);
  await w.runtime.drain();
  expect(
    w.db.query("SELECT pending,outcome FROM stt_admissions").get(),
  ).toEqual({ pending: 0, outcome: null });
});
test("acknowledgement failure blocks new reservations and shutdown never calls storage close", async () => {
  const w = world();
  w.db.exec(
    "CREATE TRIGGER fail_settlement BEFORE UPDATE OF settled_at ON stt_admissions WHEN NEW.settled_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic-private-failure'); END",
  );
  const failed = await w.request();
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("synthetic-private-failure");
  expect(
    (await w.request({ ...w.input, request_id: "after-failure" })).status,
  ).toBe(503);
  expect(w.db.query("SELECT * FROM stt_admission_usage").all()).toHaveLength(1);
  let closed = false;
  await expect(
    w.runtime.shutdown({ stop: async () => {} }, () => {
      closed = true;
    }),
  ).rejects.toThrow();
  expect(closed).toBe(false);
});

test("HTTP client abort keeps a handed-out slot until acknowledgement and background failure denies another owner's reservation", async () => {
  const h = held(),
    w = world(true, undefined, h.options),
    abort = new AbortController();
  const pending = w.app.fetch(
    new Request(w.base + w.route, {
      method: "POST",
      headers: w.headers(),
      body: JSON.stringify(w.input),
      signal: abort.signal,
    }),
  );
  await h.started;
  abort.abort();
  const early = await pending;
  expect(early.status).toBe(200);
  expect((await early.json()).pending).toBe(true);
  expect(h.signal()?.aborted).toBe(true);
  w.db.exec(
    "CREATE TRIGGER fail_late_settlement BEFORE UPDATE OF settled_at ON stt_admissions WHEN NEW.settled_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic-late-failure'); END",
  );
  h.release(transcript(w));
  await expect(w.runtime.drain()).rejects.toThrow();
  const other = w.store.media.admit(w.b.owner, {
    request_id: "other",
    audio: w.fixture.audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: "ta-IN",
  });
  const response = await w.app.request(
    `${w.base}/api/media/${other.id}/fixture-stt`,
    {
      method: "POST",
      headers: w.headers(w.b),
      body: JSON.stringify({
        request_id: "after-background-failure",
        consent_revision: 1,
      }),
    },
  );
  expect(response.status).toBe(503);
  expect(w.db.query("SELECT * FROM stt_admission_usage").all()).toHaveLength(1);
});

test("actual loopback shutdown retains kernel ownership until the worker acknowledges, then preserves no-replay state on reopen", async () => {
  const h = held(),
    w = world(true, undefined, h.options),
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: w.app.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  let closing: Promise<void> | undefined;
  try {
    const response = fetch(base + w.route, {
      method: "POST",
      headers: { ...w.headers(), Origin: base },
      body: JSON.stringify(w.input),
    });
    await h.started;
    closing = w.runtime.shutdown(server, () => w.store.close());
    expect(() => new SelfHostedStore(w.path)).toThrow("cannot be locked");
    const early = await response;
    expect(early.status).toBe(200);
    expect((await early.json()).pending).toBe(true);
    h.release(transcript(w));
    await closing;
    const reopened = new SelfHostedStore(w.path);
    try {
      expect(
        reopened.sttAdmissions.get(
          w.a.owner,
          w.db.query<{ id: string }, []>("SELECT id FROM stt_admissions").get()!
            .id,
        ).pending,
      ).toBe(false);
      expect(
        w.db.query("SELECT count(*) n FROM stt_admission_usage").get(),
      ).toEqual({ n: 1 });
    } finally {
      reopened.close();
    }
  } finally {
    h.release(transcript(w));
    if (closing) await closing;
    else server.stop(true);
  }
});

test("fixture quota remains durable and arbitrary WAV input never becomes recognized speech", async () => {
  const w = world();
  for (let i = 0; i < 4; i++)
    expect(
      (await w.request({ ...w.input, request_id: `quota-${i}` })).status,
    ).toBe(200);
  expect(
    (await w.request({ ...w.input, request_id: "quota-over" })).status,
  ).toBe(429);
  expect((await w.request({ ...w.input, request_id: "quota-0" })).status).toBe(
    200,
  );
  expect(
    w.db.query("SELECT count(*) n FROM stt_admission_usage").get(),
  ).toEqual({ n: 4 });
  const bad = world(),
    media = bad.store.media.admit(bad.a.owner, {
      request_id: "not-a-tone",
      audio: pcm16ToWav(new Uint8Array(8000), 16000),
      mimeType: "audio/wav",
      consentToStore: true,
      consentToProcess: true,
      languageHint: "ta-IN",
    });
  const response = await bad.app.request(
    `${bad.base}/api/media/${media.id}/fixture-stt`,
    {
      method: "POST",
      headers: bad.headers(),
      body: JSON.stringify({ request_id: "not-asr", consent_revision: 1 }),
    },
  );
  const result = await response.json();
  expect(result.mode).toBe("fixture");
  expect(result.state).toBe("failed");
  expect(result.outcome).toEqual({ status: "failed", code: "provider_failed" });
});

test("shutdown during role lookup prevents reservation and pre-aborted HTTP requests consume no unit", async () => {
  const w = world();
  let runtime: LocalFixtureSpeechRuntime | undefined,
    stopDuringLookup = false;
  const guarded = new LocalFixtureSpeechRuntime(w.store, () => {
    if (stopDuringLookup) runtime?.stop();
    return w.roles();
  });
  runtime = guarded;
  stopDuringLookup = true;
  await expect(
    guarded.run(w.a.owner, { ...w.input, media_id: w.media.id }),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  const response = await w.app.fetch(
    new Request(w.base + w.route, {
      method: "POST",
      headers: w.headers(),
      body: JSON.stringify(w.input),
      signal: controller.signal,
    }),
  );
  expect(response.status).toBe(408);
  expect(w.db.query("SELECT * FROM stt_admission_usage").all()).toHaveLength(0);
  expect(
    () =>
      new LocalFixtureSpeechRuntime(w.store, () => selfHostedConfig({}).roles),
  ).toThrow("fixture");
});

// Windows termination does not deliver POSIX SIGTERM; actual Bun lifecycle is covered above.
test.skipIf(process.platform === "win32")(
  "the actual application entry wires keyless fixture HTTP and gracefully stops on SIGTERM",
  async () => {
    const w = world();
    w.store.close();
    const probe = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      }),
      port = probe.port;
    probe.stop(true);
    const base = `http://127.0.0.1:${port}`,
      child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          resolve(import.meta.dir, "../src/self-hosted/index.ts"),
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
          env: {
            SAATHI_PORT: String(port),
            SAATHI_DATABASE_PATH: w.path,
            SAATHI_LOCAL_FIXTURE_SPEECH: "true",
            SAATHI_STT_PROVIDER: "fixture-a",
            BOT_MODEL: "openrouter/free",
          },
        },
      );
    try {
      let health: { fixture_speech?: boolean; speech?: boolean } | undefined;
      for (let i = 0; i < 120; i++) {
        try {
          const response = await fetch(`${base}/health`);
          if (response.ok) {
            health = await response.json();
            break;
          }
        } catch {}
        await Bun.sleep(50);
      }
      expect(health).toBeDefined();
      expect(health?.fixture_speech).toBe(true);
      expect(health?.speech).toBe(false);
      const response = await fetch(`${base}${w.route}`, {
        method: "POST",
        headers: { ...w.headers(), Origin: base },
        body: JSON.stringify(w.input),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.mode).toBe("fixture");
      expect(result.state).toBe("completed");
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      const reopened = new SelfHostedStore(w.path);
      try {
        expect(reopened.sttAdmissions.get(w.a.owner, result.id).state).toBe(
          "completed",
        );
        expect(
          w.db.query("SELECT count(*) n FROM stt_admission_usage").get(),
        ).toEqual({ n: 1 });
      } finally {
        reopened.close();
      }
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  },
  15_000,
);
