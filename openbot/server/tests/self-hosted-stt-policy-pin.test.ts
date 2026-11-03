import { expect, test } from "bun:test";
import { createSttPolicyPin } from "../src/self-hosted/stt-policy-pin";
import fixture from "./fixtures/stt-policy-pin.json";

const profile = () => structuredClone(fixture.profile);
const pin = (input: unknown = profile()) => {
  const result = createSttPolicyPin(input);
  if (result.kind !== "policy_pin")
    throw Error("Expected a synthetic policy pin");
  return result;
};

test("pins complete content with the independent Python SHA-256 reference, never an approval", () => {
  const result = pin();
  expect(result.format).toBe("saathi-stt-policy-pin-v1");
  expect(result.contentSha256).toBe(fixture.sha256);
  expect(JSON.parse(result.canonicalJson)).toEqual({
    format: result.format,
    profile: { ...profile(), languages: ["en-IN", "hi-IN", "ta-IN"] },
    effectiveLimits: profile().ceilings,
  });
  expect(Object.keys(result).sort()).toEqual([
    "canonicalJson",
    "contentSha256",
    "effectiveLimits",
    "format",
    "kind",
    "profile",
  ]);
  expect(result).not.toHaveProperty("executorToken");
  expect(result).not.toHaveProperty("approved");
});

test("key ordering and language set ordering do not change identity", () => {
  const p = profile();
  const reverse = (value: object) =>
    Object.fromEntries(Object.entries(value).reverse());
  const reordered = {
    ...reverse(p),
    price: reverse(p.price),
    ceilings: reverse(p.ceilings),
    languages: [...p.languages].reverse(),
  };
  expect(pin(reordered)).toEqual(pin(p));
  const subset = { ...p, languages: ["en-IN", "ta-IN"] };
  expect(pin({ ...p, languages: ["ta-IN", "en-IN", "ta-IN"] })).toEqual(
    pin(subset),
  );
});

test("the same revision label cannot hide changed complete policy content", () => {
  const baseline = pin().contentSha256;
  const changes = [
    { accountRef: "other-account" },
    { revision: "other-policy" },
    { languages: ["en-IN"] },
    { maxBytes: 2097151 },
    { maxDurationMs: 28999 },
    { maxSnapshotAgeMs: 9999 },
  ];
  for (const change of changes)
    expect(pin({ ...profile(), ...change }).contentSha256).not.toBe(baseline);
  const priceChanges = [
    { provider: "elevenlabs" },
    { model: "other-model" },
    { revision: "other-tariff" },
    { currency: "USD" },
    { rateMicros: 8 },
    { unitMs: 3001 },
    { quantumMs: 1001 },
    { minimumMs: 1 },
    { requestFeeMicros: 3 },
    { effectiveAt: 999 },
    { expiresAt: 9001 },
  ];
  for (const change of priceChanges)
    expect(
      pin({ ...profile(), price: { ...profile().price, ...change } })
        .contentSha256,
    ).not.toBe(baseline);
  for (const [key, value] of Object.entries(profile().ceilings))
    expect(
      pin({
        ...profile(),
        ceilings: { ...profile().ceilings, [key]: value - 1 },
      }).contentSha256,
    ).not.toBe(baseline);
});

test("deeply frozen copies do not freeze or retain caller-owned references", () => {
  const p = profile(),
    result = pin(p);
  expect(Object.isFrozen(result)).toBe(true);
  for (const object of [
    result.profile,
    result.profile.price,
    result.profile.ceilings,
    result.profile.languages,
    result.effectiveLimits,
  ]) {
    expect(Object.isFrozen(object)).toBe(true);
    expect(Reflect.set(object, "injected", "synthetic-secret")).toBe(false);
  }
  p.price.rateMicros = 999;
  p.languages.length = 0;
  p.ceilings.ownerAttempts = 0;
  expect(result.contentSha256).toBe(fixture.sha256);
  expect(result.profile.price.rateMicros).toBe(7);
  expect(result.profile.languages).toEqual(["en-IN", "hi-IN", "ta-IN"]);
});

test("strict validation and coherent ceilings reject malformed or secret-bearing metadata", () => {
  for (const bad of [
    { ...profile(), apiKey: "synthetic-secret" },
    { ...profile(), price: { ...profile().price, token: "synthetic-secret" } },
    { ...profile(), ceilings: { ...profile().ceilings, unknown: 1 } },
    { ...profile(), ceilings: { ...profile().ceilings, ownerAttempts: 21 } },
    { ...profile(), price: { ...profile().price, rateMicros: NaN } },
  ])
    expect(createSttPolicyPin(bad)).toEqual({
      kind: "denied",
      reason: "invalid_policy",
    });
});

test("disabled or throwing inputs yield fixed denials without raw exceptions", () => {
  for (const p of [undefined, null, {}, { ...profile(), enabled: false }])
    expect(createSttPolicyPin(p)).toEqual({
      kind: "denied",
      reason: "disabled",
    });
  expect(
    createSttPolicyPin({
      get enabled() {
        throw Error("synthetic-secret");
      },
    }),
  ).toEqual({ kind: "denied", reason: "invalid_input" });
});

test("canonical round-trip preserves full identity, including historical expired tariffs", () => {
  const result = pin();
  expect(pin(JSON.parse(result.canonicalJson).profile)).toEqual(result);
  // Content identity has no clock, balance, permission, reservation or provider side effect.
  expect(result.profile.price.expiresAt).toBe(9000);
});

test("effective tightened limits are part of identity, and widening cannot be pinned", () => {
  const narrowed = createSttPolicyPin(profile(), { ownerAttempts: 3 });
  if (narrowed.kind !== "policy_pin")
    throw Error("Expected a narrowed synthetic pin");
  expect(narrowed.contentSha256).not.toBe(pin().contentSha256);
  expect(narrowed.effectiveLimits.ownerAttempts).toBe(3);
  expect(narrowed.profile.ceilings.ownerAttempts).toBe(4);
  expect(createSttPolicyPin(profile(), { ownerAttempts: 5 })).toEqual({
    kind: "denied",
    reason: "invalid_limits",
  });
  expect(createSttPolicyPin(profile(), { ownerAttempts: 4 })).toEqual(pin());
  expect(createSttPolicyPin(profile(), null)).toEqual({
    kind: "denied",
    reason: "invalid_limits",
  });
  const wire = JSON.parse(narrowed.canonicalJson);
  expect(createSttPolicyPin(wire.profile, wire.effectiveLimits)).toEqual(
    narrowed,
  );
});
