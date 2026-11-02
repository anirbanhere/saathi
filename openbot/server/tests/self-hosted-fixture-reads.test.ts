import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { selfHostedConfig } from "../src/self-hosted/config";
import { LocalFixtureSpeechRuntime } from "../src/self-hosted/fixture-speech-runtime";
import {
  createFixtureSttProvider,
  syntheticSpeechFixture,
} from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { SttAdmissions } from "../src/self-hosted/stt-admission";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function world(enabled = true, publicOrigin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "saathi-fixture-reads-")),
    path = join(dir, "state.sqlite"),
    store = new SelfHostedStore(path),
    db = new Database(path),
    roles = selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles;
  let calls = 0;
  const runtime = new LocalFixtureSpeechRuntime(store, () => roles, {
      fixtureProvider: (p) => {
        calls++;
        return createFixtureSttProvider(p);
      },
    }),
    a = store.createSession(),
    b = store.createSession(),
    fixture = syntheticSpeechFixture("hi-IN");
  const media = store.media.admit(a.owner, {
    request_id: "clip",
    audio: fixture.audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: "hi-IN",
  });
  const saved = await runtime.run(a.owner, {
    request_id: "saved",
    media_id: media.id,
    consent_revision: 1,
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
    }),
    base = publicOrigin ?? "http://localhost:8790";
  const headers = (s = a) => ({ Cookie: `saathi_self_hosted=${s.token}` });
  const read = (route = "/api/fixture-stt", s = a) =>
    app.request(`${base}${route}`, { headers: headers(s) });
  cleanup.push(() => {
    runtime.stop();
    db.close();
    store.close();
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("saathi-fixture-reads-")
    )
      throw Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    path,
    store,
    db,
    roles,
    runtime,
    a,
    b,
    media,
    saved,
    fixture,
    app,
    base,
    headers,
    read,
    calls: () => calls,
  };
}
const snapshot = (db: Database) =>
  Object.fromEntries(
    [
      "stt_admissions",
      "stt_admission_usage",
      "owned_media",
      "media_consent_events",
    ].map((table) => [
      table,
      db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );

test("fixture read routes are absent by default/public and retain parent owner/query boundaries", async () => {
  for (const [enabled, origin] of [
    [false, undefined],
    [true, "https://demo.example.test"],
  ] as const) {
    const w = await world(enabled, origin);
    expect((await w.read()).status).toBe(404);
    expect((await w.read(`/api/fixture-stt/${w.saved.id}`)).status).toBe(404);
  }
  const w = await world();
  expect((await w.app.request(`${w.base}/api/fixture-stt`)).status).toBe(401);
  expect(await (await w.read("/api/fixture-stt", w.b)).json()).toEqual([]);
  expect((await w.read(`/api/fixture-stt/${w.saved.id}`, w.b)).status).toBe(
    404,
  );
  for (const route of [
    "/api/fixture-stt?owner=other",
    "/api/fixture-stt/not-an-id",
    `/api/fixture-stt/${w.saved.id}?role=other`,
  ])
    expect((await w.read(route)).status).toBe(422);
  w.db
    .query("UPDATE sessions SET owner=? WHERE owner=?")
    .run(w.a.owner, w.b.owner);
  w.db.query("UPDATE sessions SET expires=0 WHERE csrf=?").run(w.a.csrf);
  expect((await w.read()).status).toBe(401);
  expect((await w.read(`/api/fixture-stt/${w.saved.id}`)).status).toBe(401);
});

test("metadata/result reads are side-effect free, private-field free, cached and remain readable after admission stops", async () => {
  const w = await world(),
    before = snapshot(w.db);
  w.runtime.stop();
  const list = await w.read();
  expect(list.status).toBe(200);
  expect(list.headers.get("cache-control")).toBe("no-store");
  const rows = await list.json();
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(w.saved.id);
  expect(rows[0].mode).toBe("fixture");
  expect(JSON.stringify(rows)).not.toMatch(
    /outcome|transcript|"audio"|hash|token|"owner"|"role"/,
  );
  const result = await (await w.read(`/api/fixture-stt/${w.saved.id}`)).json();
  expect(result).toEqual(w.runtime.view(w.a.owner, w.saved.id));
  expect(result.outcome.transcript.text).toBe(w.fixture.text);
  expect(JSON.stringify(result)).not.toMatch(
    /claim_hash|executorToken|content_hash|"owner"|"audio"/,
  );
  expect(await (await w.read(`/api/fixture-stt/${w.saved.id}`)).json()).toEqual(
    result,
  );
  expect(snapshot(w.db)).toEqual(before);
  expect(w.calls()).toBe(1);
});

test("recent metadata is bounded, deterministic and SQL never projects retained text or executor fields", async () => {
  const w = await world();
  for (let i = 0; i < 25; i++)
    w.db
      .query(
        `INSERT INTO stt_admissions SELECT ?,owner,?,digest,media,consent_revision,content_hash,role,duration_ms,language_hint,state,created,updated,expires,pending,claim_hash,claimed_at,claim_deadline,settlement_digest,outcome,settled_at,failure_code FROM stt_admissions WHERE id=?`,
      )
      .run(randomUUID(), `seed-${i}`, w.saved.id);
  const queries: string[] = [];
  const observed = new Proxy(w.db, {
    get(target, key) {
      if (key === "query")
        return (sql: string) => {
          queries.push(sql);
          return target.query(sql);
        };
      return Reflect.get(target, key, target);
    },
  });
  const admissions = new SttAdmissions(observed, w.store.media),
    rows = admissions.list(w.a.owner);
  expect(rows).toHaveLength(20);
  expect(rows.map((r) => r.id)).toEqual(
    rows
      .map((r) => r.id)
      .sort()
      .reverse(),
  );
  for (const sql of queries.filter((sql) => /FROM stt_admissions/i.test(sql)))
    expect(sql.split(/\bFROM\b/i)[0]).not.toMatch(
      /\*|outcome|audio|hash|token|role|digest/i,
    );
  expect(
    new SttAdmissions(w.db, w.store.media, Date.now, { ownerRecords: 2 }).list(
      w.a.owner,
    ),
  ).toHaveLength(2);
  expect(
    (await (await w.read()).json()).map((r: { id: string }) => r.id),
  ).toEqual(rows.map((r) => r.id));
});

test("current consent/retention suppresses saved text without reads writing recovery or clearing state", async () => {
  for (const change of ["expire", "revoke", "delete"] as const) {
    const w = await world();
    if (change === "expire")
      w.db
        .query("UPDATE owned_media SET expires=created+1 WHERE id=?")
        .run(w.media.id);
    if (change === "revoke")
      w.store.media.revokeProcessing(w.a.owner, w.media.id);
    if (change === "delete") w.store.media.remove(w.a.owner, w.media.id);
    const before = snapshot(w.db);
    const result = await (
      await w.read(`/api/fixture-stt/${w.saved.id}`)
    ).json();
    expect(result.state).toBe("completed");
    expect(result.outcome).toBeNull();
    expect((await (await w.read()).json())[0].state).toBe("completed");
    expect(snapshot(w.db)).toEqual(before);
    expect(w.calls()).toBe(1);
  }
});

test("saved owned result survives a real store reopen and storage failures are sanitized", async () => {
  const w = await world(),
    before = await (await w.read(`/api/fixture-stt/${w.saved.id}`)).json();
  w.runtime.stop();
  await w.runtime.drain();
  w.store.close();
  const store = new SelfHostedStore(w.path),
    runtime = new LocalFixtureSpeechRuntime(store, () => w.roles);
  try {
    const app = createSelfHostedApp({
      store,
      model: "synthetic:free",
      answer: async () => "unused",
      localFixtureSpeech: true,
      fixtureSpeech: runtime,
    });
    const result = await app.request(
      `${w.base}/api/fixture-stt/${w.saved.id}`,
      { headers: w.headers() },
    );
    expect(await result.json()).toEqual(before);
    expect(
      w.db.query("SELECT count(*) n FROM stt_admission_usage").get(),
    ).toEqual({ n: 1 });
  } finally {
    runtime.stop();
    await runtime.drain();
    store.close();
  }
  const broken = await world();
  broken.db.exec("DROP TABLE stt_admissions");
  const failure = await broken.read();
  expect(failure.status).toBe(503);
  expect(await failure.text()).not.toMatch(
    /no such table|SQLite|stt_admissions/,
  );
});

test("a killed claimed worker reopens as interrupted and read recovery never replays or refunds it", async () => {
  const w = await world();
  w.runtime.stop();
  await w.runtime.drain();
  w.store.close();
  const source = (name: string) =>
    JSON.stringify(
      pathToFileURL(resolve(import.meta.dir, `../src/self-hosted/${name}.ts`))
        .href,
    );
  const script = `const {SelfHostedStore}=await import(${source("store")});const {selfHostedConfig}=await import(${source("config")});const {LocalFixtureSpeechRuntime}=await import(${source("fixture-speech-runtime")});
 const store=new SelfHostedStore(${JSON.stringify(w.path)}),roles=selfHostedConfig({SAATHI_STT_PROVIDER:"fixture-a",SAATHI_STT_TIMEOUT_MS:"1000"}).roles;
 const runtime=new LocalFixtureSpeechRuntime(store,()=>roles,{fixtureProvider:()=>({transcribe:()=>{console.log("SYNTHETIC_CLAIMED");return new Promise(()=>{});}})});
 setInterval(()=>{},1000);void runtime.run(${JSON.stringify(w.a.owner)},{request_id:"lost",media_id:${JSON.stringify(w.media.id)},consent_revision:1}).catch(()=>{});`;
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--eval", script],
    {
      stdout: "pipe",
      stderr: "ignore",
      env: { SystemRoot: process.env.SystemRoot },
    },
  );
  try {
    const reader = child.stdout.getReader(),
      timer = setTimeout(() => {
        void reader.cancel().catch(() => {});
      }, 5000);
    try {
      let received = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) throw Error("Synthetic worker did not claim");
        received += new TextDecoder().decode(part.value);
        if (received.includes("SYNTHETIC_CLAIMED")) break;
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
    expect(() => new SelfHostedStore(w.path)).toThrow("cannot be locked");
    child.kill();
    await child.exited;
    const store = new SelfHostedStore(w.path),
      runtime = new LocalFixtureSpeechRuntime(store, () => w.roles);
    try {
      const app = createSelfHostedApp({
        store,
        model: "synthetic:free",
        answer: async () => "unused",
        localFixtureSpeech: true,
        fixtureSpeech: runtime,
      });
      const list = await (
          await app.request(`${w.base}/api/fixture-stt`, {
            headers: w.headers(),
          })
        ).json(),
        lost = list.find(
          (row: { request_id: string }) => row.request_id === "lost",
        );
      expect(lost.state).toBe("interrupted");
      expect(lost.pending).toBe(false);
      const result = await (
        await app.request(`${w.base}/api/fixture-stt/${lost.id}`, {
          headers: w.headers(),
        })
      ).json();
      expect(result.outcome).toBeNull();
      expect(result.state).toBe("interrupted");
      expect(
        w.db.query("SELECT count(*) n FROM stt_admission_usage").get(),
      ).toEqual({ n: 2 });
    } finally {
      runtime.stop();
      await runtime.drain();
      store.close();
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}, 10_000);
