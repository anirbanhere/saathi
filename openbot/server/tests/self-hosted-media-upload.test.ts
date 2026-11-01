import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { selfHostedConfig } from "../src/self-hosted/config";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { pcm16ToWav } from "../src/self-hosted/wav";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
function world(enabled = true, publicOrigin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "saathi-upload-")),
    path = join(dir, "state.sqlite");
  const store = new SelfHostedStore(path),
    db = new Database(path);
  cleanups.push(() => {
    db.close();
    store.close();
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("saathi-upload-")
    )
      throw new Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  let calls = 0;
  const app = createSelfHostedApp({
    store,
    answer: async () => {
      calls++;
      throw new Error("No inference expected");
    },
    model: "synthetic:free",
    localMediaControls: true,
    localMediaUploads: enabled,
    publicOrigin,
  });
  const base = publicOrigin ?? "http://localhost:8790",
    a = store.createSession(),
    b = store.createSession();
  const headers = (session = a) => ({
    Cookie: `saathi_self_hosted=${session.token}`,
    Origin: base,
    "X-Saathi-CSRF": session.csrf,
    "Content-Type": "audio/wav",
    "X-Saathi-Request-ID": "clip",
    "X-Saathi-Consent-Store": "true",
  });
  const upload = (
    extra: Record<string, string> = {},
    audio: BodyInit = syntheticSpeechFixture("en-IN").audio,
    route = "/api/media/upload",
  ) =>
    app.request(`${base}${route}`, {
      method: "POST",
      headers: { ...headers(), ...extra },
      body: audio,
    });
  return {
    app,
    base,
    store,
    db,
    path,
    a,
    b,
    headers,
    upload,
    calls: () => calls,
  };
}

test("upload has a distinct literal local opt-in and never enables public mode", async () => {
  expect(selfHostedConfig({}).localMediaUploads).toBe(false);
  expect(
    selfHostedConfig({ SAATHI_LOCAL_MEDIA_CONTROLS: "true" }).localMediaUploads,
  ).toBe(false);
  expect(
    selfHostedConfig({ SAATHI_LOCAL_MEDIA_UPLOADS: "true" }).maxRequestBodySize,
  ).toBe(2_000_000);
  expect(selfHostedConfig({}).maxRequestBodySize).toBe(60_000);
  expect(() =>
    selfHostedConfig({ SAATHI_LOCAL_MEDIA_UPLOADS: "yes" }),
  ).toThrow();
  expect(() =>
    selfHostedConfig({
      SAATHI_LOCAL_MEDIA_UPLOADS: "true",
      SAATHI_PUBLIC_ORIGIN: "https://demo.example.test",
    }),
  ).toThrow();
  for (const [enabled, origin] of [
    [false, undefined],
    [true, "https://demo.example.test"],
  ] as const) {
    const w = world(enabled, origin);
    const health = await (await w.app.request(`${w.base}/health`)).json();
    expect(health.local_media_uploads).toBe(false);
    expect(health.speech).toBe(false);
    expect(
      (await w.upload({ "Content-Type": "application/json" }, "{}")).status,
    ).toBe(404);
    expect((await w.upload()).status).toBe(403);
    expect(w.store.media.list(w.a.owner)).toHaveLength(0);
  }
});

test("upload stores only explicitly consented owned WAV metadata, survives reopen and makes no inference", async () => {
  const w = world(),
    response = await w.upload({ "X-Saathi-Language": "ta-IN" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const result = await response.json();
  expect(result.consentToStore).toBe(true);
  expect(result.consentToProcess).toBe(false);
  expect(result.languageHint).toBe("ta-IN");
  expect(JSON.stringify(result)).not.toMatch(
    /"audio"|"owner"|hash|token|transcript/,
  );
  expect(w.store.media.read(w.a.owner, result.id)).toEqual(
    syntheticSpeechFixture("en-IN").audio,
  );
  expect(() => w.store.media.metadata(w.b.owner, result.id)).toThrow(
    "not found",
  );
  expect(
    w.db.query("SELECT kind,revision FROM media_consent_events").all(),
  ).toEqual([{ kind: "stored", revision: 1 }]);
  expect(w.db.query("SELECT * FROM stt_admissions").all()).toHaveLength(0);
  expect(w.calls()).toBe(0);
  w.store.close();
  const reopened = new SelfHostedStore(w.path);
  try {
    expect(reopened.media.metadata(w.a.owner, result.id)).toEqual(result);
  } finally {
    reopened.close();
  }
});

test("ownership, origin and CSRF gates reject upload before the application reads bytes", async () => {
  const w = world();
  for (const [extra, expected] of [
    [{ Cookie: "" }, 401],
    [{ "X-Saathi-CSRF": "wrong" }, 403],
    [{ Origin: "https://foreign.example" }, 403],
  ] as const) {
    let reads = 0;
    const body = new ReadableStream(
      {
        pull(c) {
          reads++;
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(`${w.base}/api/media/upload`, {
      method: "POST",
      headers: { ...w.headers(), ...extra },
      body,
    });
    expect((await w.app.fetch(request)).status).toBe(expected);
    expect(reads).toBe(0);
  }
  w.db.query("UPDATE sessions SET expires=0 WHERE owner=?").run(w.a.owner);
  expect((await w.upload()).status).toBe(401);
});

test("metadata is strict and cannot smuggle ownership, paths, URLs, unsupported consent or language", async () => {
  const w = world();
  const invalidMetadata: Record<string, string>[] = [
    { "X-Saathi-Consent-Store": "" },
    { "X-Saathi-Consent-Store": "false" },
    { "X-Saathi-Consent-Process": "yes" },
    { "X-Saathi-Request-ID": "../path" },
    { "X-Saathi-Language": "unsupported" },
    { "X-Saathi-Owner": w.b.owner },
    { "X-Saathi-URL": "https://example.test/audio.wav" },
    { "Content-Disposition": "attachment; filename=secret.wav" },
    { "Content-Encoding": "gzip" },
  ];
  for (const extra of invalidMetadata)
    expect((await w.upload(extra)).status).toBe(422);
  expect(
    (
      await w.upload(
        {},
        syntheticSpeechFixture("en-IN").audio,
        "/api/media/upload?owner=fake",
      )
    ).status,
  ).toBe(422);
  expect((await w.upload({ "Content-Type": "audio/mpeg" })).status).toBe(403);
  expect((await w.upload({}, new Uint8Array([1, 2, 3]))).status).toBe(422);
  expect(w.store.media.list(w.a.owner)).toHaveLength(0);
});

test("duplicates preserve consent identity and tombstones; a different owner has separate storage", async () => {
  const w = world(),
    first = await (
      await w.upload({ "X-Saathi-Consent-Process": "true" })
    ).json();
  expect(first.consentToProcess).toBe(true);
  expect(
    await (await w.upload({ "X-Saathi-Consent-Process": "true" })).json(),
  ).toEqual(first);
  expect((await w.upload()).status).toBe(409);
  const deleted = w.store.media.remove(w.a.owner, first.id);
  expect(
    await (await w.upload({ "X-Saathi-Consent-Process": "true" })).json(),
  ).toEqual(deleted);
  const other = await w.app.request(`${w.base}/api/media/upload`, {
    method: "POST",
    headers: w.headers(w.b),
    body: syntheticSpeechFixture("en-IN").audio,
  });
  expect(other.status).toBe(200);
  expect((await other.json()).id).not.toBe(first.id);
  expect(w.db.query("SELECT * FROM stt_admission_usage").all()).toHaveLength(0);
});

test("bounded WAV upload does not raise the JSON limit and rejects declared/streamed overflow", async () => {
  const w = world(),
    big = pcm16ToWav(new Uint8Array(64_000), 16_000);
  expect((await w.upload({}, big)).status).toBe(200);
  const ordinary = await w.app.request(`${w.base}/api/memories`, {
    method: "POST",
    headers: { ...w.headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ extra: "x".repeat(60_001) }),
  });
  expect(ordinary.status).toBe(413);
  for (const length of ["2000001", "oops", "1"])
    expect((await w.upload({ "Content-Length": length })).status).toBe(
      length === "1" ? 400 : 413,
    );
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(2_000_001));
    },
    cancel() {
      cancelled = true;
    },
  });
  expect(
    (await w.upload({ "X-Saathi-Request-ID": "large" }, body)).status,
  ).toBe(413);
  expect(cancelled).toBe(true);
  expect(w.store.media.list(w.a.owner)).toHaveLength(1);
});

test("quota and history failure leave no partial upload or raw storage error", async () => {
  const w = world();
  for (let i = 0; i < 10; i++)
    expect(
      (await w.upload({ "X-Saathi-Request-ID": `clip-${i}` })).status,
    ).toBe(200);
  expect((await w.upload({ "X-Saathi-Request-ID": "extra" })).status).toBe(429);
  expect(w.store.media.list(w.a.owner)).toHaveLength(10);
  const fresh = world();
  fresh.db.exec(
    "CREATE TRIGGER block_upload BEFORE INSERT ON media_consent_events BEGIN SELECT RAISE(ABORT,'synthetic-private-error'); END",
  );
  const failure = await fresh.upload();
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toContain("synthetic-private-error");
  expect(fresh.store.media.list(fresh.a.owner)).toHaveLength(0);
});

test("an upload rechecks its exact session after reading, even when the owner has another active session", async () => {
  const w = world();
  let controller!: ReadableStreamDefaultController<Uint8Array>,
    started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        started();
      },
    },
    { highWaterMark: 0 },
  );
  const pending = w.upload({}, body);
  await reading;
  w.db
    .query("UPDATE sessions SET owner=? WHERE owner=?")
    .run(w.a.owner, w.b.owner);
  w.db.query("UPDATE sessions SET expires=0 WHERE csrf=?").run(w.a.csrf);
  expect(w.store.session(w.a.token)).toBeNull();
  controller.enqueue(syntheticSpeechFixture("en-IN").audio);
  controller.close();
  expect((await pending).status).toBe(401);
  expect(w.db.query("SELECT * FROM owned_media").all()).toHaveLength(0);
});

async function heldUpload(w: ReturnType<typeof world>, session = w.a) {
  let started!: () => void,
    cancelled = false;
  const reading = new Promise<void>((resolve) => {
      started = resolve;
    }),
    abort = new AbortController();
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        started();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const response = w.app.fetch(
    new Request(`${w.base}/api/media/upload`, {
      method: "POST",
      headers: w.headers(session),
      body,
      signal: abort.signal,
    }),
  );
  await reading;
  return { response, abort, cancelled: () => cancelled };
}

test("client abort releases an upload slot without a write or raw stream failure", async () => {
  const w = world(),
    held = await heldUpload(w);
  try {
    expect((await w.upload()).status).toBe(429);
  } finally {
    held.abort.abort();
  }
  expect((await held.response).status).toBe(408);
  expect(held.cancelled()).toBe(true);
  expect(w.store.media.list(w.a.owner)).toHaveLength(0);
  expect((await w.upload()).status).toBe(200);
  const broken = new ReadableStream({
    start(c) {
      c.error(new Error("synthetic-private-stream-error"));
    },
  });
  const result = await w.upload({ "X-Saathi-Request-ID": "broken" }, broken);
  expect(result.status).toBe(400);
  expect(await result.text()).not.toContain("synthetic-private-stream-error");
});

test("at most four different owners can hold upload buffers and every abort frees capacity", async () => {
  const w = world(),
    held: Awaited<ReturnType<typeof heldUpload>>[] = [];
  try {
    for (let i = 0; i < 4; i++)
      held.push(await heldUpload(w, w.store.createSession()));
    expect((await w.upload()).status).toBe(429);
  } finally {
    for (const upload of held) upload.abort.abort();
    await Promise.all(held.map((upload) => upload.response));
  }
  expect((await w.upload()).status).toBe(200);
});

test("a stalled body times out and cancels its reader instead of retaining an upload slot", async () => {
  const w = world(),
    held = await heldUpload(w);
  const result = await held.response;
  expect(result.status).toBe(408);
  expect(held.cancelled()).toBe(true);
  expect(w.store.media.list(w.a.owner)).toHaveLength(0);
  expect((await w.upload()).status).toBe(200);
}, 20_000);

test("the opt-in transport accepts a generated WAV over60KB through a real loopback Bun server", async () => {
  const w = world(),
    config = selfHostedConfig({ SAATHI_LOCAL_MEDIA_UPLOADS: "true" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: config.maxRequestBodySize,
    fetch: w.app.fetch,
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const result = await fetch(`${origin}/api/media/upload`, {
      method: "POST",
      headers: { ...w.headers(), Origin: origin },
      body: pcm16ToWav(new Uint8Array(64_000), 16_000),
    });
    expect(result.status).toBe(200);
    expect((await result.json()).byteLength).toBe(64_044);
    const denied = await fetch(`${origin}/api/memories`, {
      method: "POST",
      headers: {
        ...w.headers(),
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ extra: "x".repeat(60_001) }),
    });
    expect(denied.status).toBe(413);
  } finally {
    server.stop(true);
  }
});
