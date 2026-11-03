import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ownDatabase } from "../src/self-hosted/database-ownership";
import { maintainMedia } from "../src/self-hosted/media-maintenance";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { SelfHostedStore } from "../src/self-hosted/store";
import {
  migrateSttBudgetHolds,
  SttBudgetHolds,
} from "../src/self-hosted/stt-budget-holds";
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
      `INSERT INTO stt_budget_holds(id,owner,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available) SELECT '00000000-0000-4000-8000-000000000001',?,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,0,billable_ms,balance_at,balance_available FROM stt_budget_holds LIMIT 1`,
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
    "DROP TABLE stt_hold_roles; DROP TABLE stt_budget_holds; UPDATE version SET value=12; CREATE VIEW stt_budget_holds AS SELECT 1 AS unsupported",
  );
  expect(() => attemptOpen(w.path)).toThrow("storage is unavailable");
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
  ).toBe(15);
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
    INSERT INTO stt_budget_holds(id,owner,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available) SELECT printf('00000000-0000-4000-8000-%012d',x),'synthetic-owner-'||x,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available FROM n CROSS JOIN (SELECT * FROM stt_budget_holds LIMIT 1)`);
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
    `INSERT INTO stt_budget_holds(id,owner,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available) SELECT '00000000-0000-4000-8000-000000005000','synthetic-owner-5000',request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available FROM stt_budget_holds LIMIT 1`,
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

// The lifecycle method cancels only this runtime's provably never-dispatched holds.
test("cancelled unissued holds release local balance while preserving exact identity and attempt history", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a),
    input = w.input(media);
  w.balance(5);
  const held = w.store.sttBudgetHolds.reserve(a, input);
  const cancelled = w.store.sttBudgetHolds.cancelUnissued(a, held.id);
  expect(cancelled.state).toBe("cancelled_unissued");
  expect(cancelled.estimateMicros).toBe(5);
  expect(cancelled.outstandingMicros).toBe(0);
  expect(cancelled.executionAllowed).toBe(false);
  w.advance(1000);
  expect(w.store.sttBudgetHolds.cancelUnissued(a, held.id)).toEqual(cancelled);
  expect(w.store.sttBudgetHolds.reserve(a, input)).toEqual(cancelled);
  expect(w.calls()).toBe(1);
  const next = w.store.sttBudgetHolds.reserve(a, w.input(media, "next"));
  expect(next.state).toBe("held");
  expect(next.outstandingMicros).toBe(5);
  expect(w.count()).toBe(2);
});

test("unissued cancellation needs owner context but no current media consent or balance reader", () => {
  const w = world(),
    a = w.owner(),
    b = w.owner(),
    media = w.clip(a),
    held = w.store.sttBudgetHolds.reserve(a, w.input(media));
  w.store.media.remove(a, media.id);
  const disabled = new SttBudgetHolds(
    w.db,
    w.store.media,
    w.store.sttPolicies,
    w.now,
  );
  expect(() => disabled.cancelUnissued(b, held.id)).toThrow("not found");
  expect(() =>
    disabled.cancelUnissued(a, { id: held.id, approved: true }),
  ).toThrow("Invalid");
  const cancelled = disabled.cancelUnissued(a, held.id);
  expect(cancelled.state).toBe("cancelled_unissued");
  expect(w.store.media.metadata(a, media.id).state).toBe("deleted");
  expect(w.count()).toBe(1);
});

test("unissued cancellation preserves daily attempts, audio and lifetime record consumption", () => {
  const w = world(),
    a = w.owner(),
    media = w.clip(a);
  const p = w.profile({
    revision: "retry-caps",
    ceilings: {
      ...w.base.ceilings,
      ownerAttempts: 2,
      globalAttempts: 2,
      ownerRecords: 2,
      globalRecords: 2,
      requestCostMicros: 5,
      ownerCostMicros: 5,
      globalCostMicros: 5,
    },
  });
  w.store.sttPolicies.register(p);
  const input = (id: string) => ({
    ...w.input(media, id),
    policy: { ...w.input(media).policy, revision: "retry-caps" },
  });
  for (const id of ["one", "two"]) {
    const hold = w.store.sttBudgetHolds.reserve(a, input(id));
    w.store.sttBudgetHolds.cancelUnissued(a, hold.id);
  }
  expect(() => w.store.sttBudgetHolds.reserve(a, input("three"))).toThrow(
    "budget or balance",
  );
  const tomorrow =
    Date.parse(new Date(w.now()).toISOString().slice(0, 10)) + 86400000;
  w.advance(tomorrow - w.now());
  const fresh = w.clip(a, "new-day");
  expect(() =>
    w.store.sttBudgetHolds.reserve(a, {
      ...input("next-day"),
      media_id: fresh.id,
      consent_revision: fresh.consentRevision,
    }),
  ).toThrow("budget or balance");
  expect(w.count()).toBe(2);
  const audio = world(),
    b = audio.owner(),
    clip = audio.clip(b);
  const bounded = audio.profile({
    revision: "audio-only",
    ceilings: {
      ...audio.base.ceilings,
      ownerAudioMs: clip.durationMs,
      globalAudioMs: clip.durationMs,
    },
  });
  audio.store.sttPolicies.register(bounded);
  const request = {
    ...audio.input(clip),
    policy: { ...audio.input(clip).policy, revision: "audio-only" },
  };
  audio.store.sttBudgetHolds.cancelUnissued(
    b,
    audio.store.sttBudgetHolds.reserve(b, request).id,
  );
  expect(() =>
    audio.store.sttBudgetHolds.reserve(b, { ...request, request_id: "retry" }),
  ).toThrow("budget or balance");
});

test("SQL guards prevent cancelling with changed evidence, reopening, unknown states and initial cancelled rows", () => {
  const w = world(),
    a = w.owner(),
    hold = w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
  expect(() =>
    w.db
      .query(
        "UPDATE stt_budget_holds SET state='cancelled_unissued',cancelled_at=?,cost_micros=0 WHERE id=?",
      )
      .run(w.now(), hold.id),
  ).toThrow("immutable");
  expect(() =>
    w.db
      .query("UPDATE stt_budget_holds SET state='remote_unknown' WHERE id=?")
      .run(hold.id),
  ).toThrow("immutable");
  const cancelled = w.store.sttBudgetHolds.cancelUnissued(a, hold.id);
  expect(() =>
    w.db
      .query(
        "UPDATE stt_budget_holds SET state='held',cancelled_at=NULL WHERE id=?",
      )
      .run(hold.id),
  ).toThrow("immutable");
  expect(() => w.db.exec("DELETE FROM stt_budget_holds")).toThrow("immutable");
  const b = w.owner();
  expect(() =>
    w.db
      .query(
        `INSERT INTO stt_budget_holds SELECT '00000000-0000-4000-8000-000000000001',?,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available,state,cancelled_at FROM stt_budget_holds LIMIT 1`,
      )
      .run(b),
  ).toThrow("must start held");
  expect(w.store.sttBudgetHolds.get(a, hold.id)).toEqual(cancelled);
  expect(w.count()).toBe(1);
});

test("expired owners, invalid clocks and unexpected guards cannot release a hold", () => {
  const w = world(),
    a = w.owner(),
    hold = w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
  w.advance(-1);
  expect(() => w.store.sttBudgetHolds.cancelUnissued(a, hold.id)).toThrow(
    "storage is unavailable",
  );
  w.advance(1);
  w.db.exec(
    "CREATE TRIGGER injected_cancel AFTER UPDATE ON stt_budget_holds BEGIN INSERT INTO owners VALUES('synthetic-injected'); END",
  );
  expect(() => w.store.sttBudgetHolds.cancelUnissued(a, hold.id)).toThrow(
    "storage is unavailable",
  );
  expect(
    w.db.query("SELECT id FROM owners WHERE id='synthetic-injected'").get(),
  ).toBeNull();
  w.db.exec("DROP TRIGGER injected_cancel");
  w.db.query("UPDATE sessions SET expires=? WHERE owner=?").run(w.now(), a);
  expect(() => w.store.sttBudgetHolds.cancelUnissued(a, hold.id)).toThrow(
    "active owner session",
  );
  expect(
    w.db
      .query("SELECT state,cancelled_at,cost_micros FROM stt_budget_holds")
      .get(),
  ).toEqual({ state: "held", cancelled_at: null, cost_micros: 5 });
});

// Construct the exact old journal format only in a fresh synthetic test database.
function attemptOpen(path: string) {
  const candidate = new SelfHostedStore(path);
  stores.push(candidate);
}
function legacy13(w: ReturnType<typeof world>) {
  w.store.close();
  const columns =
    "id,owner,request,media,consent_revision,content_hash,policy_hash,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available";
  w.db
    .transaction(() => {
      w.db.exec(
        `CREATE TABLE synthetic_hold_copy AS SELECT ${columns} FROM stt_budget_holds; DROP TABLE stt_hold_roles; DROP TABLE stt_budget_holds`,
      );
      migrateSttBudgetHolds(w.db);
      w.db.exec(
        `INSERT INTO stt_budget_holds(${columns}) SELECT ${columns} FROM synthetic_hold_copy; DROP TABLE synthetic_hold_copy; UPDATE version SET value=13`,
      );
    })
    .immediate();
  expect(
    w.db
      .query<{ name: string }, []>("PRAGMA table_info(stt_budget_holds)")
      .all()
      .some((c) => c.name === "state"),
  ).toBe(false);
}

test("the exact13 migration preserves original holds and cancelled history survives maintenance and restart", () => {
  const w = world(),
    a = w.owner(),
    b = w.owner(),
    media = w.clip(a),
    hold = w.store.sttBudgetHolds.reserve(a, w.input(media));
  const other = w.store.sttBudgetHolds.reserve(b, w.input(w.clip(b)));
  const thread = w.store.createThread(a, "saathi"),
    run = w.store.beginRun(
      a,
      thread.id,
      "before-migration",
      "Synthetic message",
    );
  w.store.completeRun(a, run.id, "Synthetic answer");
  legacy13(w);
  const reopened = new SelfHostedStore(w.path, {
    now: w.now,
    sttBalanceReader: (scope) => ({
      ...scope,
      observedAt: w.now(),
      availableMicros: 10,
    }),
  });
  stores.push(reopened);
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(15);
  expect(reopened.sttBudgetHolds.get(a, hold.id)).toEqual(hold);
  expect(reopened.sttBudgetHolds.get(b, other.id)).toEqual(other);
  expect(reopened.media.metadata(a, media.id)).toEqual(media);
  expect(reopened.thread(a, thread.id).messages.at(-1)?.content).toBe(
    "Synthetic answer",
  );
  expect(
    w.db
      .query<{ n: number }, []>("SELECT count(*) n FROM inference_usage")
      .get()?.n,
  ).toBe(1);
  const cancelled = reopened.sttBudgetHolds.cancelUnissued(a, hold.id);
  reopened.sttBudgetHolds.reserve(a, w.input(media, "after-cancel"));
  reopened.close();
  w.advance(media.expiresAt - w.now() + 1);
  expect(maintainMedia(w.path, { apply: true, now: w.now }).clearedClips).toBe(
    2,
  );
  const again = new SelfHostedStore(w.path, { now: w.now });
  stores.push(again);
  expect(again.sttBudgetHolds.cancelUnissued(a, hold.id)).toEqual(cancelled);
  expect(again.sttBudgetHolds.get(b, other.id)).toEqual(other);
  expect(
    w.db.query("PRAGMA foreign_key_check(stt_budget_holds)").all(),
  ).toEqual([]);
  expect(w.count()).toBe(3);
});

test("migration refuses incoming cascading references without deleting child rows or changing version", () => {
  const w = world(),
    a = w.owner(),
    hold = w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
  legacy13(w);
  w.db.exec(
    "CREATE TABLE synthetic_child(hold TEXT REFERENCES STT_BUDGET_HOLDS(id) ON DELETE CASCADE)",
  );
  w.db.query("INSERT INTO synthetic_child VALUES(?)").run(hold.id);
  expect(() => attemptOpen(w.path)).toThrow("storage is unavailable");
  expect(
    w.db.query<{ value: number }, []>("SELECT value FROM version").get()?.value,
  ).toBe(13);
  expect(w.db.query("SELECT hold FROM synthetic_child").get()).toEqual({
    hold: hold.id,
  });
  expect(w.count()).toBe(1);
  w.db.exec("DROP TABLE synthetic_child");
  const reopened = new SelfHostedStore(w.path, { now: w.now });
  stores.push(reopened);
  expect(reopened.sttBudgetHolds.get(a, hold.id)).toEqual(hold);
});

test("staging collisions and custom journal indices deny migration without destroying operator data", () => {
  for (const kind of ["staging", "index"]) {
    const w = world(),
      a = w.owner(),
      hold = w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
    legacy13(w);
    if (kind === "staging")
      w.db.exec(
        "CREATE TABLE stt_budget_holds_next(marker TEXT); INSERT INTO stt_budget_holds_next VALUES('synthetic-operator-data')",
      );
    else
      w.db.exec(
        "CREATE INDEX synthetic_custom_hold ON stt_budget_holds(created)",
      );
    expect(() => attemptOpen(w.path)).toThrow("storage is unavailable");
    expect(
      w.db.query<{ value: number }, []>("SELECT value FROM version").get()
        ?.value,
    ).toBe(13);
    expect(w.count()).toBe(1);
    if (kind === "staging") {
      expect(
        w.db.query("SELECT marker FROM stt_budget_holds_next").get(),
      ).toEqual({ marker: "synthetic-operator-data" });
      w.db.exec("DROP TABLE stt_budget_holds_next");
    } else w.db.exec("DROP INDEX synthetic_custom_hold");
    const reopened = new SelfHostedStore(w.path, { now: w.now });
    stores.push(reopened);
    expect(reopened.sttBudgetHolds.get(a, hold.id)).toEqual(hold);
  }
});

test("cancellation rechecks an owner session after validating stored policy evidence", () => {
  const w = world(),
    a = w.owner(),
    held = w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
  w.db.query("UPDATE sessions SET expires=? WHERE owner=?").run(w.now() + 2, a);
  const journal = new SttBudgetHolds(
    w.db,
    w.store.media,
    w.store.sttPolicies,
    () => {
      w.advance(1);
      return w.now();
    },
  );
  expect(() => journal.cancelUnissued(a, held.id)).toThrow(
    "active owner session",
  );
  expect(
    w.db.query("SELECT state,cancelled_at FROM stt_budget_holds").get(),
  ).toEqual({ state: "held", cancelled_at: null });
});

test("copy failure and a post-drop schema error roll back the old13 journal and release ownership", () => {
  for (const kind of ["foreign-key-copy", "dependent-view"]) {
    const w = world(),
      a = w.owner(),
      b = w.owner(),
      hold = w.store.sttBudgetHolds.reserve(a, w.input(w.clip(a)));
    legacy13(w);
    if (kind === "foreign-key-copy")
      w.db
        .query(
          `INSERT INTO stt_budget_holds SELECT '00000000-0000-4000-8000-000000000001',?,request,media,consent_revision,content_hash,?,effective_json,effective_hash,duration_ms,byte_length,language,created,cost_micros,billable_ms,balance_at,balance_available FROM stt_budget_holds LIMIT 1`,
        )
        .run(b, "0".repeat(64));
    else
      w.db.exec(
        "CREATE VIEW synthetic_hold_view AS SELECT id FROM stt_budget_holds",
      );
    expect(() => attemptOpen(w.path)).toThrow("storage is unavailable");
    expect(
      w.db.query<{ value: number }, []>("SELECT value FROM version").get()
        ?.value,
    ).toBe(13);
    expect(
      w.db
        .query(
          "SELECT name FROM sqlite_schema WHERE name='stt_budget_holds_next'",
        )
        .get(),
    ).toBeNull();
    expect(
      w.db
        .query<{ name: string }, []>("PRAGMA table_info(stt_budget_holds)")
        .all()
        .some((c) => c.name === "state"),
    ).toBe(false);
    expect(w.count()).toBe(kind === "foreign-key-copy" ? 2 : 1);
    if (kind === "dependent-view")
      expect(w.db.query("SELECT id FROM synthetic_hold_view").get()).toEqual({
        id: hold.id,
      });
    const release = ownDatabase(w.path);
    release();
  }
});
