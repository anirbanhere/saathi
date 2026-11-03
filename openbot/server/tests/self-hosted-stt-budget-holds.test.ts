import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import { SttBudgetHolds } from "../src/self-hosted/stt-budget-holds";
import fixture from "./fixtures/stt-policy-pin.json";

const folders: string[] = [],
  stores: SelfHostedStore[] = [],
  readers: Database[] = [];
afterEach(() => {
  for (const db of readers.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of folders.splice(0)) {
    if (
      dirname(resolve(dir)) !== resolve(tmpdir()) ||
      !basename(dir).startsWith("saathi-budget-hold-")
    )
      throw Error("Unsafe cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});
function world(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "saathi-budget-hold-"));
  folders.push(dir);
  const path = join(dir, "state.sqlite");
  let now = Date.now(),
    available = 100,
    calls = 0;
  let observation:
    | ((scope: {
        provider: string;
        accountRef: string;
        currency: string;
      }) => unknown)
    | undefined;
  const reader = (scope: {
    provider: string;
    accountRef: string;
    currency: string;
  }) => {
    calls++;
    return observation
      ? observation(scope)
      : { ...scope, observedAt: now, availableMicros: available };
  };
  const store = new SelfHostedStore(path, {
    now: () => now,
    sttBalanceReader: enabled ? reader : undefined,
  });
  stores.push(store);
  const db = new Database(path);
  readers.push(db);
  const profile = (changes = {}) => ({
    ...structuredClone(fixture.profile),
    price: {
      ...fixture.profile.price,
      effectiveAt: now - 1000,
      expiresAt: now + 172800000,
    },
    ...changes,
  });
  const base = profile();
  store.sttPolicies.register(base);
  const owner = () => store.createSession().owner;
  const clip = (owner: string, request = "clip") =>
    store.media.admit(owner, {
      request_id: request,
      audio: syntheticSpeechFixture("ta-IN").audio,
      mimeType: "audio/wav",
      consentToStore: true,
      consentToProcess: true,
      languageHint: "ta-IN",
    });
  const input = (media: ReturnType<typeof clip>, request_id = "hold") => ({
    request_id,
    media_id: media.id,
    consent_revision: media.consentRevision,
    policy: {
      provider: "sarvam",
      accountRef: "synthetic-account",
      revision: "policy-v1",
    },
  });
  const count = () =>
    db.query<{ n: number }, []>("SELECT count(*) n FROM stt_budget_holds").get()
      ?.n;
  return {
    store,
    db,
    path,
    owner,
    clip,
    input,
    count,
    profile,
    base,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    balance: (n: number) => {
      available = n;
    },
    observe: (fn: typeof observation) => {
      observation = fn;
    },
    calls: () => calls,
  };
}

test("budget holds are disabled without a trusted reader and cannot execute a provider", () => {
  expect(SttBudgetHolds).toBeDefined();
  const w = world(false),
    a = w.owner(),
    media = w.clip(a);
  expect(() => w.store.sttBudgetHolds.reserve(a, w.input(media))).toThrow(
    "disabled",
  );
  expect(w.count()).toBe(0);
});

test("owned current media reserves once and duplicate identity cannot change effective limits", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a),
    input = w.input(media);
  const hold = w.store.sttBudgetHolds.reserve(a, input);
  expect(hold.kind).toBe("budget_hold");
  expect(hold.executionAllowed).toBe(false);
  expect(hold.estimateMicros).toBe(5);
  expect(JSON.stringify(hold)).not.toMatch(
    /content_hash|canonical|token|audio|accountRef/,
  );
  expect(Object.isFrozen(hold)).toBe(true);
  w.advance(10001);
  expect(w.store.sttBudgetHolds.reserve(a, input)).toEqual(hold);
  expect(w.calls()).toBe(1);
  expect(w.count()).toBe(1);
  expect(() =>
    w.store.sttBudgetHolds.reserve(a, {
      ...input,
      tightenedLimits: { requestCostMicros: 50 },
    }),
  ).toThrow("different content");
  expect(() =>
    w.store.sttBudgetHolds.reserve(a, { ...input, request_id: "another" }),
  ).toThrow("pending");
});

test("foreign ownership, missing consent and client balance or cost overrides cannot create holds", () => {
  const w = world(),
    a = w.owner(),
    b = w.owner(),
    media = w.clip(a),
    input = w.input(media);
  expect(() => w.store.sttBudgetHolds.reserve(b, input)).toThrow();
  for (const extra of [
    { owner: b },
    { availableMicros: 9999 },
    { estimateMicros: 0 },
    { role: {} },
    { executionAllowed: true },
  ])
    expect(() =>
      w.store.sttBudgetHolds.reserve(a, { ...input, ...extra }),
    ).toThrow("Invalid");
  w.store.media.revokeProcessing(a, media.id);
  expect(() => w.store.sttBudgetHolds.reserve(a, input)).toThrow();
  expect(w.calls()).toBe(0);
  expect(w.count()).toBe(0);
});

test("stale, future, malformed and thrown balance observations roll back without exposing payloads", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a),
    input = w.input(media);
  const observations = [
    (scope: object) => ({
      ...scope,
      observedAt: w.now() - 10000,
      availableMicros: 100,
    }),
    (scope: object) => ({
      ...scope,
      observedAt: w.now() + 1,
      availableMicros: 100,
    }),
    (scope: object) => ({
      ...scope,
      observedAt: w.now(),
      availableMicros: 100,
      outstandingMicros: 0,
    }),
    (scope: object) => ({
      ...scope,
      accountRef: "wrong",
      observedAt: w.now(),
      availableMicros: 100,
    }),
    (_scope: object) => {
      throw Error("synthetic-private-payload");
    },
    (_scope: object) => Promise.resolve({ availableMicros: 100 }),
    (_scope: object) => Promise.reject(Error("synthetic-private-payload")),
  ];
  for (const observe of observations) {
    w.observe(observe);
    let message = "";
    try {
      w.store.sttBudgetHolds.reserve(a, input);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/Speech (balance|budget)/);
    expect(message).not.toContain("synthetic-private-payload");
    expect(w.count()).toBe(0);
  }
  w.observe(undefined);
  expect(w.store.sttBudgetHolds.reserve(a, input).estimateMicros).toBe(5);
});

test("policy revisions cannot reset account units and outstanding holds survive UTC rollover", () => {
  const w = world(),
    a = w.owner(),
    first = w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
  const p = w.profile({
    revision: "limited",
    ceilings: {
      ...w.base.ceilings,
      ownerAttempts: 1,
      globalAttempts: 1,
      requestCostMicros: 5,
      ownerCostMicros: 5,
      globalCostMicros: 5,
    },
  });
  w.store.sttPolicies.register(p);
  const b = w.owner(),
    media = w.clip(b);
  const input = {
    ...w.input(media),
    policy: { ...w.input(media).policy, revision: "limited" },
  };
  expect(() => w.store.sttBudgetHolds.reserve(b, input)).toThrow(
    "budget or balance",
  );
  const tomorrow =
    Date.parse(new Date(w.now()).toISOString().slice(0, 10)) + 86400000;
  w.advance(tomorrow - w.now());
  const c = w.owner(),
    fresh = w.clip(c),
    next = { ...w.input(fresh), policy: input.policy };
  w.balance(9);
  expect(() => w.store.sttBudgetHolds.reserve(c, next)).toThrow(
    "budget or balance",
  );
  w.balance(10);
  expect(w.store.sttBudgetHolds.reserve(c, next).estimateMicros).toBe(5);
  expect(w.store.sttBudgetHolds.get(a, first.id)).toEqual(first);
  expect(w.count()).toBe(2);
});

test("currency balances stay separate while attempts and pending owners cannot evade account history", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a);
  w.balance(5);
  w.store.sttBudgetHolds.reserve(a, w.input(media));
  const usd = w.profile({
    revision: "usd",
    price: { ...w.base.price, currency: "USD" },
  });
  w.store.sttPolicies.register(usd);
  const b = w.owner(),
    input = {
      ...w.input(w.clip(b)),
      policy: { ...w.input(media).policy, revision: "usd" },
    };
  expect(w.store.sttBudgetHolds.reserve(b, input).currency).toBe("USD");
  const cap = w.profile({
    revision: "usd-limited",
    price: { ...w.base.price, currency: "USD" },
    ceilings: { ...w.base.ceilings, ownerAttempts: 1, globalAttempts: 1 },
  });
  w.store.sttPolicies.register(cap);
  const c = w.owner();
  expect(() =>
    w.store.sttBudgetHolds.reserve(c, {
      ...w.input(w.clip(c)),
      policy: { ...input.policy, revision: "usd-limited" },
    }),
  ).toThrow("budget or balance");
  const other = w.profile({ accountRef: "other-account" });
  w.store.sttPolicies.register(other);
  const d = w.owner();
  expect(
    w.store.sttBudgetHolds.reserve(d, {
      ...w.input(w.clip(d)),
      policy: {
        ...input.policy,
        revision: "policy-v1",
        accountRef: "other-account",
      },
    }).estimateMicros,
  ).toBe(5);
  expect(() =>
    w.store.sttBudgetHolds.reserve(a, {
      ...w.input(media, "other-request"),
      policy: {
        ...input.policy,
        revision: "policy-v1",
        accountRef: "other-account",
      },
    }),
  ).toThrow("pending");
  expect(w.count()).toBe(3);
});

test("reentrant observation and consent changes during observation deny without consuming units", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a),
    input = w.input(media);
  w.observe(() => w.store.sttBudgetHolds.reserve(a, input));
  expect(() => w.store.sttBudgetHolds.reserve(a, input)).toThrow(
    "balance observation is unavailable",
  );
  expect(w.count()).toBe(0);
  w.observe((scope) => {
    w.store.media.revokeProcessing(a, media.id);
    return { ...scope, observedAt: w.now(), availableMicros: 100 };
  });
  expect(() => w.store.sttBudgetHolds.reserve(a, input)).toThrow();
  expect(w.count()).toBe(0);
  // External observation acquisition must not enroll a separate privacy action in the hold transaction.
  expect(w.store.media.metadata(a, media.id).consentToProcess).toBe(false);
  w.observe(undefined);
  const fresh = w.clip(a, "fresh-after-revoke");
  expect(
    w.store.sttBudgetHolds.reserve(a, w.input(fresh)).executionAllowed,
  ).toBe(false);
});

test("immutable guards and unknown triggers protect insertion and historical holds survive privacy deletion", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a),
    input = w.input(media);
  w.db.exec(
    "CREATE TRIGGER injected_hold AFTER INSERT ON stt_budget_holds BEGIN INSERT INTO owners VALUES('synthetic-injected'); END",
  );
  expect(() => w.store.sttBudgetHolds.reserve(a, input)).toThrow(
    "storage is unavailable",
  );
  expect(
    w.db.query("SELECT id FROM owners WHERE id='synthetic-injected'").get(),
  ).toBeNull();
  w.db.exec("DROP TRIGGER injected_hold");
  const hold = w.store.sttBudgetHolds.reserve(a, input);
  expect(() => w.db.exec("UPDATE stt_budget_holds SET cost_micros=0")).toThrow(
    "immutable",
  );
  expect(() => w.db.exec("DELETE FROM stt_budget_holds")).toThrow("immutable");
  w.store.media.remove(a, media.id);
  expect(w.store.sttBudgetHolds.get(a, hold.id)).toEqual(hold);
  const b = w.owner();
  expect(() => w.store.sttBudgetHolds.get(b, hold.id)).toThrow("not found");
  expect(w.count()).toBe(1);
});

test("corrupt stored cost denies future aggregate checks instead of minting balance", () => {
  const w = world(),
    a = w.owner();
  w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
  const b = w.owner();
  w.db
    .query(
      `INSERT INTO stt_budget_holds SELECT '00000000-0000-4000-8000-000000000001',?,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,0,billable_ms,balance_at,balance_available FROM stt_budget_holds LIMIT 1`,
    )
    .run(b);
  expect(() =>
    w.store.sttBudgetHolds.get(b, "00000000-0000-4000-8000-000000000001"),
  ).toThrow("storage is unavailable");
  const c = w.owner();
  expect(() => w.store.sttBudgetHolds.reserve(c, w.input(w.clip(c)))).toThrow(
    "storage is unavailable",
  );
  expect(w.count()).toBe(2);
});

test("reopen preserves every outstanding hold without fixture-style interruption or refund", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a),
    hold = w.store.sttBudgetHolds.reserve(a, w.input(media));
  w.store.close();
  const reopened = new SelfHostedStore(w.path, {
    now: w.now,
    sttBalanceReader: (scope) => ({
      ...scope,
      observedAt: w.now(),
      availableMicros: 5,
    }),
  });
  stores.push(reopened);
  expect(reopened.sttBudgetHolds.get(a, hold.id)).toEqual(hold);
  const b = reopened.createSession().owner;
  const clip = reopened.media.admit(b, {
    request_id: "after-reopen",
    audio: syntheticSpeechFixture("ta-IN").audio,
    mimeType: "audio/wav",
    consentToStore: true,
    consentToProcess: true,
    languageHint: "ta-IN",
  });
  expect(() => reopened.sttBudgetHolds.reserve(b, w.input(clip))).toThrow(
    "budget or balance",
  );
  expect(w.count()).toBe(1);
  const disabled = new SttBudgetHolds(
    w.db,
    reopened.media,
    reopened.sttPolicies,
    w.now,
  );
  expect(disabled.get(a, hold.id)).toEqual(hold);
  expect(() => disabled.reserve(a, w.input(media))).toThrow("disabled");
});

test("an intervening owner's committed transaction is included before the original request reserves", () => {
  const w = world(),
    a = w.owner(),
    b = w.owner(),
    first = w.input(w.clip(a)),
    second = w.input(w.clip(b));
  const independent = new SttBudgetHolds(
    w.db,
    w.store.media,
    w.store.sttPolicies,
    w.now,
    (scope) => ({ ...scope, observedAt: w.now(), availableMicros: 5 }),
  );
  let committed: ReturnType<typeof independent.reserve> | undefined;
  w.observe((scope) => {
    committed = independent.reserve(b, second);
    return { ...scope, observedAt: w.now(), availableMicros: 5 };
  });
  expect(() => w.store.sttBudgetHolds.reserve(a, first)).toThrow(
    "budget or balance",
  );
  expect(w.count()).toBe(1);
  expect(committed?.executionAllowed).toBe(false);
  if (!committed) throw Error("Expected a synthetic hold");
  expect(w.store.sttBudgetHolds.get(b, committed.id)).toEqual(committed);
});

test("audio and lifetime record ceilings include earlier policies and days", () => {
  const w = world(),
    a = w.owner(),
    initial = w.clip(a);
  w.store.sttBudgetHolds.reserve(a, w.input(initial));
  const audio = w.profile({
    revision: "audio-cap",
    ceilings: {
      ...w.base.ceilings,
      ownerAudioMs: initial.durationMs,
      globalAudioMs: initial.durationMs,
    },
  });
  w.store.sttPolicies.register(audio);
  const b = w.owner(),
    media = w.clip(b);
  expect(() =>
    w.store.sttBudgetHolds.reserve(b, {
      ...w.input(media),
      policy: { ...w.input(media).policy, revision: "audio-cap" },
    }),
  ).toThrow("budget or balance");
  w.advance(86400000 - (w.now() % 86400000));
  const lifetime = w.profile({
    revision: "record-cap",
    ceilings: { ...w.base.ceilings, ownerRecords: 1, globalRecords: 1 },
  });
  w.store.sttPolicies.register(lifetime);
  const c = w.owner(),
    fresh = w.clip(c);
  expect(() =>
    w.store.sttBudgetHolds.reserve(c, {
      ...w.input(fresh),
      policy: { ...w.input(fresh).policy, revision: "record-cap" },
    }),
  ).toThrow("budget or balance");
  expect(w.count()).toBe(1);
});

test("synthetic schema12 upgrades preserve policy, media and inference; malformed upgrade rolls back", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a),
    thread = w.store.createThread(a, "saathi"),
    run = w.store.beginRun(a, thread.id, "synthetic-run", "Synthetic message");
  w.store.completeRun(a, run.id, "Synthetic answer");
  w.store.close();
  w.db.exec(
    "DROP TABLE stt_budget_holds; UPDATE version SET value=12; CREATE VIEW stt_budget_holds AS SELECT 1 AS unsupported",
  );
  expect(() => new SelfHostedStore(w.path)).toThrow("storage is unavailable");
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(12);
  w.db.exec("DROP VIEW stt_budget_holds");
  const reopened = new SelfHostedStore(w.path, {
    now: w.now,
    sttBalanceReader: (scope) => ({
      ...scope,
      observedAt: w.now(),
      availableMicros: 100,
    }),
  });
  stores.push(reopened);
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(13);
  expect(
    reopened.sttPolicies.get(
      { provider: "sarvam", accountRef: "synthetic-account" },
      "policy-v1",
    ),
  ).toBeDefined();
  expect(reopened.media.metadata(a, media.id)).toEqual(media);
  expect(reopened.thread(a, thread.id).messages.at(-1)?.content).toBe(
    "Synthetic answer",
  );
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(1);
  expect(
    reopened.sttBudgetHolds.reserve(a, w.input(media)).estimateMicros,
  ).toBe(5);
});

test("active-owner session is rechecked after observation and expired owners cannot recover history", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a),
    input = w.input(media);
  w.observe((scope) => {
    w.db.query("UPDATE sessions SET expires=? WHERE owner=?").run(w.now(), a);
    return { ...scope, observedAt: w.now(), availableMicros: 100 };
  });
  expect(() => w.store.sttBudgetHolds.reserve(a, input)).toThrow(
    "active owner session",
  );
  expect(w.count()).toBe(0);
  const b = w.owner(),
    fresh = w.clip(b);
  w.observe(undefined);
  const hold = w.store.sttBudgetHolds.reserve(b, w.input(fresh));
  w.db.query("UPDATE sessions SET expires=? WHERE owner=?").run(w.now(), b);
  expect(() => w.store.sttBudgetHolds.get(b, hold.id)).toThrow(
    "active owner session",
  );
  expect(w.count()).toBe(1);
});

test("hard journal capacity is not widened by a reviewed profile and excess stored rows fail closed", () => {
  const w = world(),
    a = w.owner();
  w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
  w.db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4999)
    INSERT INTO stt_budget_holds SELECT printf('00000000-0000-4000-8000-%012d',x),'synthetic-owner-'||x,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available FROM n CROSS JOIN (SELECT * FROM stt_budget_holds LIMIT 1)`);
  const wide = w.profile({
    revision: "wide-records",
    ceilings: { ...w.base.ceilings, globalRecords: 9007199254740991 },
  });
  w.store.sttPolicies.register(wide);
  const b = w.owner(),
    media = w.clip(b),
    input = {
      ...w.input(media),
      policy: { ...w.input(media).policy, revision: "wide-records" },
    };
  expect(() => w.store.sttBudgetHolds.reserve(b, input)).toThrow("capacity");
  expect(w.count()).toBe(5000);
  w.db.exec(
    `INSERT INTO stt_budget_holds SELECT '00000000-0000-4000-8000-000000005000','synthetic-owner-5000',request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available FROM stt_budget_holds LIMIT 1`,
  );
  expect(() => w.store.sttBudgetHolds.reserve(b, input)).toThrow(
    "storage is unavailable",
  );
  expect(w.count()).toBe(5001);
}, 15000);

test("an identical request committed during observation returns its original hold rather than a pending conflict", () => {
  const w = world(),
    a = w.owner(),
    input = w.input(w.clip(a));
  const independent = new SttBudgetHolds(
    w.db,
    w.store.media,
    w.store.sttPolicies,
    w.now,
    (scope) => ({ ...scope, observedAt: w.now(), availableMicros: 5 }),
  );
  let committed: ReturnType<typeof independent.reserve> | undefined;
  w.observe((scope) => {
    committed = independent.reserve(a, input);
    return { ...scope, observedAt: w.now(), availableMicros: 5 };
  });
  const recovered = w.store.sttBudgetHolds.reserve(a, input);
  if (!committed) throw Error("Expected a synthetic committed hold");
  expect(recovered).toEqual(committed);
  expect(w.count()).toBe(1);
});

test("balance freshness is rechecked at the decision after local ledger and media validation", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a);
  const short = w.profile({
    revision: "short-observation",
    maxSnapshotAgeMs: 2,
  });
  w.store.sttPolicies.register(short);
  const journal = new SttBudgetHolds(
    w.db,
    w.store.media,
    w.store.sttPolicies,
    () => {
      w.advance(1);
      return w.now();
    },
    (scope) => ({ ...scope, observedAt: w.now(), availableMicros: 100 }),
  );
  expect(() =>
    journal.reserve(a, {
      ...w.input(media),
      policy: { ...w.input(media).policy, revision: "short-observation" },
    }),
  ).toThrow("budget or balance");
  expect(w.count()).toBe(0);
});

test("consent expiry reached during local validation denies at the final reservation clock", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a);
  w.db
    .query("UPDATE owned_media SET expires=? WHERE id=?")
    .run(w.now() + 3, media.id);
  const journal = new SttBudgetHolds(
    w.db,
    w.store.media,
    w.store.sttPolicies,
    () => {
      w.advance(1);
      return w.now();
    },
    (scope) => ({ ...scope, observedAt: w.now(), availableMicros: 100 }),
  );
  expect(() => journal.reserve(a, w.input(media))).toThrow(
    "media is unavailable",
  );
  expect(w.count()).toBe(0);
});
