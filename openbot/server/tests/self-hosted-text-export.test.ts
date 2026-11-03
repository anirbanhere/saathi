import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createSelfHostedApp } from "../src/self-hosted/app";
import { SelfHostedStore } from "../src/self-hosted/store";
import { createOwnedTextExport } from "../src/self-hosted/text-export";

const stores: SelfHostedStore[] = [],
  dbs: Database[] = [],
  folders: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const folder of folders.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("saathi-text-export-")
    )
      throw Error("Unsafe test cleanup");
    rmSync(folder, { recursive: true, force: true });
  }
});
function world() {
  const folder = mkdtempSync(join(tmpdir(), "saathi-text-export-"));
  folders.push(folder);
  const path = join(folder, "state.sqlite"),
    store = new SelfHostedStore(path);
  stores.push(store);
  const a = store.createSession(),
    b = store.createSession(),
    db = new Database(path);
  dbs.push(db);
  return { path, store, a, b, db };
}
function seed(store: SelfHostedStore, owner: string) {
  const thread = store.createThread(owner, "saathi"),
    run = store.beginRun(owner, thread.id, "synthetic", "சென்னை मौसम 🌦️");
  store.completeRun(owner, run.id, "Synthetic answer", {
    sources: [
      { title: "synthetic-private-source", url: "https://synthetic.invalid" },
    ],
    searchedAt: "2026-11-03T00:00:00Z",
    searchCalls: 1,
  });
  const memory = store.saveMemory(owner, "சோதனை preference", true);
  return { thread, run, memory };
}
const requestBody = {
  scope: "conversations_and_reviewed_preferences",
} as const;

test("empty export declares its limited complete scope without writes or authority", () => {
  const { store, a, db } = world();
  const before = db.query("SELECT count(*) n FROM inference_usage").get();
  const result = store.exportText(a.owner);
  expect(result.format).toBe("saathi-text-export-v1");
  expect(result.scope).toBe(requestBody.scope);
  expect(result.complete_for_scope).toBe(true);
  expect(result.exported_at).toBeGreaterThan(0);
  expect(result.threads).toEqual([]);
  expect(result.memories).toEqual([]);
  expect(result.excluded).toContain("credentials_and_sessions");
  expect(db.query("SELECT count(*) n FROM inference_usage").get()).toEqual(
    before,
  );
  expect(result).not.toHaveProperty("owner");
});

test("only owned exact Unicode conversation text and reviewed preferences are projected; deletes and reopen persist", () => {
  const { store, a, b, db, path } = world(),
    own = seed(store, a.owner);
  seed(store, b.owner);
  const result = store.exportText(a.owner),
    text = JSON.stringify(result);
  expect(result.threads).toHaveLength(1);
  expect(result.threads[0]?.messages.map((m) => m.content)).toEqual([
    "சென்னை मौसम 🌦️",
    "Synthetic answer",
  ]);
  expect(result.memories).toEqual([own.memory]);
  for (const privateValue of [
    a.owner,
    b.owner,
    a.token,
    a.csrf,
    own.run.id,
    "synthetic-private-source",
    "https://synthetic.invalid",
  ])
    expect(text).not.toContain(privateValue);
  expect(Object.keys(result.threads[0] ?? {}).sort()).toEqual([
    "agent",
    "created",
    "id",
    "messages",
    "updated",
  ]);
  expect(Object.keys(result.threads[0]?.messages[0] ?? {}).sort()).toEqual([
    "content",
    "id",
    "role",
  ]);
  const before = db.query("PRAGMA data_version").get();
  const repeated = store.exportText(a.owner);
  expect(repeated.threads).toEqual(result.threads);
  expect(repeated.memories).toEqual(result.memories);
  expect(db.query("PRAGMA data_version").get()).toEqual(before);
  store.close();
  const reopened = new SelfHostedStore(path);
  stores.push(reopened);
  expect(reopened.exportText(a.owner).threads).toEqual(result.threads);
  reopened.deleteThread(a.owner, own.thread.id);
  reopened.deleteMemory(a.owner, own.memory.id);
  expect(reopened.exportText(a.owner).threads).toEqual([]);
  expect(reopened.exportText(a.owner).memories).toEqual([]);
});

test("foreign, malformed and expired owner contexts cannot export and expiry is rechecked before returning", () => {
  const { store, a, db } = world();
  seed(store, a.owner);
  for (const owner of [randomUUID(), "invalid-owner", "' OR 1=1 --"])
    expect(() => store.exportText(owner)).toThrow("active owner session");
  const expiry = Date.now() + 10000;
  db.query("UPDATE sessions SET expires=? WHERE owner=?").run(expiry, a.owner);
  let calls = 0;
  expect(() =>
    createOwnedTextExport(db, a.owner, () =>
      ++calls === 1 ? expiry - 1 : expiry + 1,
    ),
  ).toThrow("active owner session");
  db.query("UPDATE sessions SET expires=0 WHERE owner=?").run(a.owner);
  expect(() => store.exportText(a.owner)).toThrow("active owner session");
});

test("corrupt projected rows fail closed with a fixed message rather than a partial export", () => {
  for (const edit of [
    "UPDATE messages SET role='synthetic-private-bad'",
    "UPDATE messages SET content=''",
    "UPDATE messages SET seq=7",
    "UPDATE threads SET agent='synthetic-private-bad'",
    "UPDATE memories SET content=zeroblob(3000000)",
  ]) {
    const { store, a, db } = world();
    seed(store, a.owner);
    db.exec(edit);
    expect(() => store.exportText(a.owner)).toThrow(
      "Text export data is unavailable.",
    );
  }
});

test("row and actual serialized UTF-8 byte limits deny without silent truncation", () => {
  for (const kind of ["threads", "messages", "memories", "bytes"]) {
    const { store, a, db } = world(),
      thread = store.createThread(a.owner, "saathi");
    if (kind === "threads")
      for (let i = 0; i < 30; i++)
        db.query("INSERT INTO threads VALUES(?,?,?,?,?)").run(
          randomUUID(),
          a.owner,
          "saathi",
          1,
          1,
        );
    if (kind === "memories")
      for (let i = 0; i < 21; i++)
        db.query("INSERT INTO memories VALUES(?,?,?,?)").run(
          randomUUID(),
          a.owner,
          "Synthetic",
          1,
        );
    if (kind === "messages" || kind === "bytes")
      for (let i = 0; i < (kind === "messages" ? 101 : 60); i++)
        db.query("INSERT INTO messages VALUES(?,?,?,?,?)").run(
          randomUUID(),
          thread.id,
          "assistant",
          kind === "bytes" ? "க".repeat(16000) : "Synthetic",
          i,
        );
    expect(() => store.exportText(a.owner)).toThrow(
      "Text export exceeds this demo's download budget.",
    );
  }
});

test("one WAL read snapshot cannot combine conversations with later preferences; independent changes persist", () => {
  const { store, a, db, path } = world();
  const own = seed(store, a.owner);
  const writer = new Database(path);
  dbs.push(writer);
  let changed = false;
  let ticks = 0;
  const result = createOwnedTextExport(db, a.owner, () => {
    if (++ticks === 2) {
      changed = true;
      writer
        .transaction(() => {
          writer
            .query("UPDATE threads SET agent='inventory' WHERE id=?")
            .run(own.thread.id);
          writer
            .query("UPDATE messages SET content='Later text' WHERE thread=?")
            .run(own.thread.id);
          writer
            .query(
              "UPDATE memories SET content='Later preference' WHERE owner=?",
            )
            .run(a.owner);
        })
        .immediate();
    }
    return Date.now();
  });
  expect(result.threads[0]?.agent).toBe("saathi");
  expect(changed).toBe(true);
  expect(result.threads[0]?.messages[0]?.content).toBe("சென்னை मौसम 🌦️");
  expect(result.memories[0]?.content).toBe("சோதனை preference");
  expect(store.exportText(a.owner).memories[0]?.content).toBe(
    "Later preference",
  );
});

test("explicit download uses existing auth/origin/CSRF and rejects body/query selectors without inference", async () => {
  const { store, a, b, db } = world();
  seed(store, a.owner);
  seed(store, b.owner);
  let answers = 0;
  const app = createSelfHostedApp({
    store,
    model: "synthetic:free",
    answer: async () => {
      answers++;
      return "Synthetic";
    },
  });
  const url = "http://localhost:8790/api/text-export";
  const headers = {
    origin: "http://localhost:8790",
    "content-type": "application/json",
    cookie: `saathi_self_hosted=${a.token}`,
    "x-saathi-csrf": a.csrf,
  };
  const send = (
    body: unknown = requestBody,
    changes: Record<string, string> = {},
    suffix = "",
  ) =>
    app.request(url + suffix, {
      method: "POST",
      headers: { ...headers, ...changes },
      body: JSON.stringify(body),
    });
  expect(
    (
      await app.request(url, {
        method: "POST",
        headers: { origin: headers.origin, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      })
    ).status,
  ).toBe(401);
  expect((await send(requestBody, { "x-saathi-csrf": "wrong" })).status).toBe(
    403,
  );
  expect(
    (await send(requestBody, { origin: "https://synthetic.invalid" })).status,
  ).toBe(403);
  expect((await send({ ...requestBody, owner: b.owner })).status).toBe(422);
  expect((await send({ scope: "everything" })).status).toBe(422);
  expect((await send(requestBody, {}, `?owner=${b.owner}`)).status).toBe(422);
  expect((await app.request(url, { headers })).status).toBe(404);
  const before = db.query("SELECT count(*) n FROM inference_usage").get();
  const response = await send();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="saathi-text-export.json"',
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-type")).toContain("application/json");
  const result = await response.json();
  expect(result.threads).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(b.owner);
  expect(answers).toBe(0);
  expect(db.query("SELECT count(*) n FROM inference_usage").get()).toEqual(
    before,
  );
  db.query("UPDATE sessions SET expires=0 WHERE owner=?").run(a.owner);
  expect((await send()).status).toBe(401);
});

test("oversized/corrupt identity cannot be truncated into another owner's message lookup", () => {
  const { store, a, b, db } = world(),
    foreign = seed(store, b.owner);
  db.query("INSERT INTO threads VALUES(?,?,?,?,?)").run(
    `${foreign.thread.id}\0synthetic-private`,
    a.owner,
    "saathi",
    1,
    1,
  );
  expect(() => store.exportText(a.owner)).toThrow(
    "Text export data is unavailable.",
  );
});

test("serialized control characters are exact and storage failures stay fixed unavailable errors", () => {
  const { store, a, db } = world();
  const thread = store.createThread(a.owner, "saathi");
  const run = store.beginRun(
    a.owner,
    thread.id,
    "controls",
    "Synthetic\0\n\t text",
  );
  store.completeRun(a.owner, run.id, 'Synthetic "quoted" \\ text');
  const result = store.exportText(a.owner);
  expect(
    JSON.parse(JSON.stringify(result)).threads[0].messages[0].content,
  ).toBe("Synthetic\0\n\t text");
  db.exec("DROP TABLE memories");
  expect(() => store.exportText(a.owner)).toThrow(
    "Text export data is unavailable.",
  );
});

test("exact serialized byte ceiling succeeds and one additional byte refuses the whole export", () => {
  const { store, a, db } = world();
  const first = store.createThread(a.owner, "saathi"),
    second = store.createThread(a.owner, "saathi");
  for (let i = 0; i < 124; i++)
    db.query("INSERT INTO messages VALUES(?,?,?,?,?)").run(
      randomUUID(),
      i < 100 ? first.id : second.id,
      "assistant",
      "X".repeat(16000),
      i % 100,
    );
  const initial = store.exportText(a.owner),
    bytes = Buffer.byteLength(JSON.stringify(initial));
  const last = { id: randomUUID(), role: "assistant", content: "" };
  const remaining =
    2_000_000 - bytes - Buffer.byteLength(JSON.stringify(last)) - 1;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThan(16000);
  db.query("INSERT INTO messages VALUES(?,?,?,?,?)").run(
    last.id,
    second.id,
    last.role,
    "X".repeat(remaining),
    24,
  );
  expect(Buffer.byteLength(JSON.stringify(store.exportText(a.owner)))).toBe(
    2_000_000,
  );
  db.query("UPDATE messages SET content=content||'X' WHERE id=?").run(last.id);
  expect(() => store.exportText(a.owner)).toThrow(
    "Text export exceeds this demo's download budget.",
  );
});
