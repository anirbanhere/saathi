import { expect, test } from "bun:test";
import { estimateSttCost } from "../src/self-hosted/stt-cost";

const now = 10000;
const price = () => ({
  enabled: true,
  provider: "sarvam",
  model: "synthetic-price-example",
  revision: "synthetic-v1",
  currency: "INR",
  rateMicros: 7,
  unitMs: 3000,
  quantumMs: 1000,
  minimumMs: 0,
  requestFeeMicros: 2,
  effectiveAt: 9000,
  expiresAt: 11000,
});
const media = { durationMs: 1001 };
const ceiling = { currency: "INR", maxEstimateMicros: 100 };

test("cost arithmetic is disabled unless explicitly selected and never returns a lease", () => {
  for (const policy of [undefined, null, {}, { ...price(), enabled: false }])
    expect(estimateSttCost(policy, media, ceiling, now)).toEqual({
      kind: "denied",
      reason: "disabled",
    });
  const result = estimateSttCost(price(), media, ceiling, now);
  expect(result).toEqual({
    kind: "estimate",
    provider: "sarvam",
    model: "synthetic-price-example",
    priceRevision: "synthetic-v1",
    currency: "INR",
    billableMs: 2000,
    estimateMicros: 7,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(result).not.toHaveProperty("executorToken");
  expect(result).not.toHaveProperty("approved");
});

test("rounds duration and rational micro-unit cost upward, including minimum and fee", () => {
  const result = estimateSttCost(
    { ...price(), minimumMs: 4500 },
    media,
    ceiling,
    now,
  );
  expect(result).toMatchObject({
    kind: "estimate",
    billableMs: 5000,
    estimateMicros: 14,
  });
  expect(
    estimateSttCost({ ...price(), rateMicros: 0 }, media, ceiling, now),
  ).toMatchObject({ kind: "estimate", estimateMicros: 2 });
});

test("ceiling is exact and never exchanges currencies", () => {
  expect(
    estimateSttCost(price(), media, { ...ceiling, maxEstimateMicros: 7 }, now)
      .kind,
  ).toBe("estimate");
  expect(
    estimateSttCost(price(), media, { ...ceiling, maxEstimateMicros: 6 }, now),
  ).toEqual({ kind: "denied", reason: "ceiling_exceeded" });
  expect(
    estimateSttCost(price(), media, { ...ceiling, currency: "USD" }, now),
  ).toEqual({ kind: "denied", reason: "currency_mismatch" });
});

test("rejects unknown, future and expired tariff evidence at exact boundaries", () => {
  const { rateMicros: _missing, ...unknown } = price();
  expect(estimateSttCost(unknown, media, ceiling, now)).toEqual({
    kind: "denied",
    reason: "invalid_price",
  });
  for (const clock of [8999, 11000])
    expect(estimateSttCost(price(), media, ceiling, clock)).toEqual({
      kind: "denied",
      reason: "stale_price",
    });
  expect(estimateSttCost(price(), media, ceiling, 9000).kind).toBe("estimate");
});

test("refuses unsafe, fractional, nonfinite and zero billing denominators", () => {
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      estimateSttCost({ ...price(), rateMicros: value }, media, ceiling, now)
        .kind,
    ).toBe("denied");
    expect(
      estimateSttCost(
        price(),
        media,
        { ...ceiling, maxEstimateMicros: value },
        now,
      ).kind,
    ).toBe("denied");
  }
  for (const field of ["unitMs", "quantumMs"])
    expect(
      estimateSttCost({ ...price(), [field]: 0 }, media, ceiling, now).kind,
    ).toBe("denied");
});

test("uses exact integer arithmetic and refuses an unrepresentable final cost", () => {
  const large = {
    ...price(),
    rateMicros: Number.MAX_SAFE_INTEGER,
    unitMs: 1000000,
    quantumMs: 1,
    requestFeeMicros: 0,
  };
  const result = estimateSttCost(
    large,
    { durationMs: 29000 },
    { ...ceiling, maxEstimateMicros: Number.MAX_SAFE_INTEGER },
    now,
  );
  expect(result).toMatchObject({
    kind: "estimate",
    estimateMicros: 261208778387489,
  });
  expect(estimateSttCost({ ...large, unitMs: 1 }, media, ceiling, now)).toEqual(
    { kind: "denied", reason: "overflow" },
  );
});

test("strict trusted metadata cannot carry provider, owner or credential overrides", () => {
  for (const extra of [
    { provider: "elevenlabs" },
    { model: "other" },
    { owner: "other" },
    { apiKey: "synthetic-secret" },
  ])
    expect(
      estimateSttCost(price(), { ...media, ...extra }, ceiling, now),
    ).toEqual({ kind: "denied", reason: "invalid_media" });
  expect(
    estimateSttCost(
      { ...price(), apiKey: "synthetic-secret" },
      media,
      ceiling,
      now,
    ),
  ).toEqual({ kind: "denied", reason: "invalid_price" });
  for (const durationMs of [0, 99, 29001, 100.5, NaN, Infinity])
    expect(estimateSttCost(price(), { durationMs }, ceiling, now).kind).toBe(
      "denied",
    );
});

test("denies malformed clocks and sanitizes throwing in-process input", () => {
  for (const clock of [NaN, Infinity, -1, 0.5])
    expect(estimateSttCost(price(), media, ceiling, clock)).toEqual({
      kind: "denied",
      reason: "invalid_clock",
    });
  const malicious = {
    get enabled() {
      throw Error("synthetic-secret");
    },
  };
  expect(estimateSttCost(malicious, media, ceiling, now)).toEqual({
    kind: "denied",
    reason: "invalid_input",
  });
});

test("pins only explicit scalar estimate metadata and supports a separately reviewed USD tariff", () => {
  const p = { ...price(), provider: "elevenlabs", currency: "USD" };
  const result = estimateSttCost(
    p,
    media,
    { ...ceiling, currency: "USD" },
    now,
  );
  p.model = "changed";
  p.revision = "changed";
  expect(result).toMatchObject({
    kind: "estimate",
    provider: "elevenlabs",
    currency: "USD",
    model: "synthetic-price-example",
    priceRevision: "synthetic-v1",
  });
  expect(Object.keys(result).sort()).toEqual([
    "billableMs",
    "currency",
    "estimateMicros",
    "kind",
    "model",
    "priceRevision",
    "provider",
  ]);
  expect(media).toEqual({ durationMs: 1001 });
});

test("denies inverted tariff windows and malformed ceilings without coercion", () => {
  expect(
    estimateSttCost({ ...price(), expiresAt: 9000 }, media, ceiling, now),
  ).toEqual({ kind: "denied", reason: "invalid_price" });
  for (const cap of [
    undefined,
    { ...ceiling, maxEstimateMicros: "100" },
    { ...ceiling, owner: "other" },
  ])
    expect(estimateSttCost(price(), media, cap, now)).toEqual({
      kind: "denied",
      reason: "invalid_ceiling",
    });
});
