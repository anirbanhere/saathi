import { expect, test } from "bun:test";
import { createSttBudgetPreview } from "../src/self-hosted/stt-budget";

const now = Date.parse("2026-11-03T12:00:00Z");
const owner = "owner-synthetic";
const profile = () => ({
  enabled: true,
  revision: "policy-v1",
  accountRef: "synthetic-account",
  languages: ["en-IN", "hi-IN", "ta-IN"],
  maxBytes: 2097152,
  maxDurationMs: 29000,
  maxSnapshotAgeMs: 10000,
  price: {
    enabled: true,
    provider: "sarvam",
    model: "synthetic-model",
    revision: "tariff-v1",
    currency: "INR",
    rateMicros: 7,
    unitMs: 3000,
    quantumMs: 1000,
    minimumMs: 0,
    requestFeeMicros: 2,
    effectiveAt: now - 60000,
    expiresAt: now + 60000,
  },
  ceilings: {
    ownerAttempts: 4,
    globalAttempts: 20,
    ownerAudioMs: 60000,
    globalAudioMs: 300000,
    ownerRecords: 100,
    globalRecords: 5000,
    requestCostMicros: 100,
    ownerCostMicros: 400,
    globalCostMicros: 2000,
  },
});
const media = {
  durationMs: 1001,
  byteLength: 33000,
  channels: 1,
  language: "ta-IN",
};
const counters = () => ({ attempts: 0, audioMs: 0, records: 0, costMicros: 0 });
const usage = () => ({
  provider: "sarvam",
  currency: "INR",
  ownerRef: owner,
  accountRef: "synthetic-account",
  policyRevision: "policy-v1",
  day: "2026-11-03",
  observedAt: now,
  ownerPending: false,
  owner: counters(),
  global: counters(),
});
const balance = () => ({
  provider: "sarvam",
  accountRef: "synthetic-account",
  currency: "INR",
  observedAt: now,
  availableMicros: 10,
  outstandingMicros: 3,
});
const evaluate = (p: unknown = profile(), limits?: unknown) =>
  createSttBudgetPreview(p, limits);

test("preview is disabled by default and is not an admission or reservation", () => {
  for (const p of [undefined, {}, { ...profile(), enabled: false }])
    expect(
      createSttBudgetPreview(p)(owner, media, usage(), balance(), now),
    ).toEqual({
      kind: "denied",
      reason: "disabled",
    });
  const result = evaluate()(owner, media, usage(), balance(), now);
  expect(result).toEqual({
    kind: "budget_preview",
    policyRevision: "policy-v1",
    provider: "sarvam",
    model: "synthetic-model",
    priceRevision: "tariff-v1",
    currency: "INR",
    billableMs: 2000,
    estimateMicros: 7,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result).not.toHaveProperty("executorToken");
  expect(result).not.toHaveProperty("approved");
});

test("pending owners and inconsistent global snapshots cannot obtain a positive preview", () => {
  expect(
    evaluate()(
      owner,
      media,
      { ...usage(), ownerPending: true },
      balance(),
      now,
    ),
  ).toEqual({ kind: "denied", reason: "pending_owner" });
  for (const field of Object.keys(counters())) {
    const u = usage();
    u.owner[field as keyof ReturnType<typeof counters>] = 1;
    expect(evaluate()(owner, media, u, balance(), now)).toEqual({
      kind: "denied",
      reason: "invalid_usage",
    });
  }
});

test("all owner/global prospective counters honor exact tightened boundaries", () => {
  const cases = [
    {
      field: "attempts",
      increment: 1,
      cap: 2,
      limits: { ownerAttempts: 2, globalAttempts: 2 },
    },
    {
      field: "records",
      increment: 1,
      cap: 2,
      limits: { ownerRecords: 2, globalRecords: 2 },
    },
    {
      field: "audioMs",
      increment: 1001,
      cap: 2002,
      limits: { ownerAudioMs: 2002, globalAudioMs: 2002 },
    },
    {
      field: "costMicros",
      increment: 7,
      cap: 14,
      limits: {
        requestCostMicros: 14,
        ownerCostMicros: 14,
        globalCostMicros: 14,
      },
    },
  ] as const;
  for (const c of cases)
    for (const scope of ["owner", "global"] as const) {
      const preview = evaluate(profile(), c.limits);
      const u = usage();
      u[scope][c.field] = c.cap - c.increment;
      if (scope === "owner") u.global[c.field] = u.owner[c.field];
      expect(preview(owner, media, u, balance(), now).kind).toBe(
        "budget_preview",
      );
      u[scope][c.field]++;
      if (scope === "owner") u.global[c.field] = u.owner[c.field];
      expect(preview(owner, media, u, balance(), now)).toEqual({
        kind: "denied",
        reason: "budget_exceeded",
      });
    }
});

test("large prospective counter additions cannot round below a ceiling", () => {
  const p = profile();
  p.ceilings.globalCostMicros = Number.MAX_SAFE_INTEGER;
  const u = usage();
  u.global.costMicros = Number.MAX_SAFE_INTEGER - 1;
  expect(evaluate(p)(owner, media, u, balance(), now)).toEqual({
    kind: "denied",
    reason: "budget_exceeded",
  });
});

test("malformed policies, limits, clocks and snapshots deny without coercion or raw errors", () => {
  for (const limits of [
    null,
    [],
    { ownerAttempts: 0 },
    { globalAttempts: 1 },
    { unknown: 1 },
  ])
    expect(
      evaluate(profile(), limits)(owner, media, usage(), balance(), now).kind,
    ).toBe("denied");
  expect(
    evaluate({ ...profile(), apiKey: "synthetic-secret" })(
      owner,
      media,
      usage(),
      balance(),
      now,
    ),
  ).toEqual({ kind: "denied", reason: "invalid_policy" });
  for (const clock of [NaN, Infinity, -1, 0.1])
    expect(evaluate()(owner, media, usage(), balance(), clock)).toEqual({
      kind: "denied",
      reason: "invalid_clock",
    });
  for (const value of [NaN, Infinity, -1, 0.1, Number.MAX_SAFE_INTEGER + 1])
    expect(
      evaluate()(
        owner,
        media,
        usage(),
        { ...balance(), availableMicros: value },
        now,
      ).kind,
    ).toBe("denied");
  const poisoned = {
    get ownerRef() {
      throw Error("synthetic-secret");
    },
  };
  expect(evaluate()(owner, media, poisoned, balance(), now)).toEqual({
    kind: "denied",
    reason: "invalid_input",
  });
});

test("tariff expiry and narrowed language/size profiles cannot be bypassed with saved-looking evidence", () => {
  const p = profile();
  p.price.expiresAt = now;
  expect(evaluate(p)(owner, media, usage(), balance(), now)).toEqual({
    kind: "denied",
    reason: "cost_unavailable",
  });
  const reduced = {
    ...profile(),
    languages: ["en-IN"],
    maxBytes: 1000,
    maxDurationMs: 1000,
  };
  expect(evaluate(reduced)(owner, media, usage(), balance(), now)).toEqual({
    kind: "denied",
    reason: "invalid_media",
  });
});

test("unknown or exhausted balance denies even a syntactically valid tariff", () => {
  expect(evaluate()(owner, media, usage(), undefined, now)).toEqual({
    kind: "denied",
    reason: "invalid_balance",
  });
  expect(
    evaluate()(
      owner,
      media,
      usage(),
      { ...balance(), availableMicros: 9 },
      now,
    ),
  ).toEqual({ kind: "denied", reason: "balance_exceeded" });
  expect(
    evaluate()(
      owner,
      media,
      usage(),
      { ...balance(), outstandingMicros: 11 },
      now,
    ).kind,
  ).toBe("denied");
});

test("scope, currency, UTC day and freshness must match the closed profile", () => {
  for (const change of [
    { ownerRef: "other" },
    { provider: "elevenlabs" },
    { currency: "USD" },
    { accountRef: "other" },
    { policyRevision: "other" },
    { day: "2026-11-02" },
  ])
    expect(
      evaluate()(owner, media, { ...usage(), ...change }, balance(), now).kind,
    ).toBe("denied");
  for (const observedAt of [now + 1, now - 10000]) {
    expect(
      evaluate()(owner, media, { ...usage(), observedAt }, balance(), now).kind,
    ).toBe("denied");
    expect(
      evaluate()(owner, media, usage(), { ...balance(), observedAt }, now).kind,
    ).toBe("denied");
  }
  expect(
    evaluate()(owner, media, usage(), { ...balance(), currency: "USD" }, now),
  ).toEqual({ kind: "denied", reason: "context_mismatch" });
  expect(
    evaluate()(
      owner,
      media,
      usage(),
      { ...balance(), provider: "elevenlabs" },
      now,
    ),
  ).toEqual({ kind: "denied", reason: "context_mismatch" });
});

test("overrides can only tighten reviewed ceilings and affect the canonical cost", () => {
  for (const [key, cap] of Object.entries(profile().ceilings))
    expect(
      evaluate(profile(), { [key]: cap + 1 })(
        owner,
        media,
        usage(),
        balance(),
        now,
      ),
    ).toEqual({ kind: "denied", reason: "invalid_limits" });
  expect(
    evaluate(profile(), { requestCostMicros: 6 })(
      owner,
      media,
      usage(),
      balance(),
      now,
    ),
  ).toEqual({ kind: "denied", reason: "cost_unavailable" });
  expect(
    evaluate(profile(), { requestCostMicros: 7 })(
      owner,
      media,
      usage(),
      balance(),
      now,
    ).kind,
  ).toBe("budget_preview");
});

test("client role, owner, monetary and metadata overrides cannot cross this boundary", () => {
  for (const extra of [
    { provider: "elevenlabs" },
    { model: "other" },
    { ownerRef: "other" },
    { estimateMicros: 0 },
    { limits: {} },
    { apiKey: "synthetic-secret" },
  ])
    expect(
      evaluate()(owner, { ...media, ...extra }, usage(), balance(), now),
    ).toEqual({ kind: "denied", reason: "invalid_media" });
  for (const change of [
    { channels: 2 },
    { byteLength: 2097153 },
    { durationMs: 29001 },
    { language: "ml-IN" },
  ])
    expect(
      evaluate()(owner, { ...media, ...change }, usage(), balance(), now).kind,
    ).toBe("denied");
});

test("configuration is copied and preview calls neither consume nor mutate supplied counters", () => {
  const p = profile(),
    u = usage(),
    b = balance();
  const before = JSON.stringify({ u, b });
  const preview = evaluate(p);
  p.price.rateMicros = 999;
  p.languages.length = 0;
  p.ceilings.ownerAttempts = 0;
  const one = preview(owner, media, u, b, now);
  expect(preview(owner, media, u, b, now)).toEqual(one);
  expect(one).toMatchObject({ kind: "budget_preview", estimateMicros: 7 });
  expect(JSON.stringify({ u, b })).toBe(before);
});
