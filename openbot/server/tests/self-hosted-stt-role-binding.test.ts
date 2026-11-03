import { expect, test } from "bun:test";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import { createSttRoleBinding } from "../src/self-hosted/stt-role-binding";
import { createSarvamStt } from "../src/self-hosted/vendor-stt";
import policyFixture from "./fixtures/stt-policy-pin.json";
import reference from "./fixtures/stt-role-binding.json";

const profile = () => ({
  ...structuredClone(policyFixture.profile),
  maxBytes: 2_000_000,
  price: { ...policyFixture.profile.price, model: "saaras:v3" },
});
const role = () => ({
  provider: "sarvam",
  model: "saaras:v3",
  languages: ["ta-IN", "en-IN", "hi-IN"],
  timeoutMs: 20000,
});

test("a matching actual role and complete policy have immutable compatibility identity, never execution authority", () => {
  const result = createSttRoleBinding(profile(), role());
  expect(result.kind).toBe("role_binding");
  if (result.kind !== "role_binding")
    throw Error("Expected synthetic compatibility metadata");
  expect(result.executionAllowed).toBe(false);
  expect(result.contentSha256).not.toBe(result.policy.contentSha256);
  expect(Object.isFrozen(result.role.languages)).toBe(true);
  expect(result.role.languages).toEqual(["en-IN", "hi-IN", "ta-IN"]);
  expect(result).not.toHaveProperty("approved");
});

test("default, fixture, disabled, wrong provider/model and overly broad media policies deny", () => {
  expect(createSttRoleBinding().kind).toBe("denied");
  for (const r of [
    undefined,
    { ...role(), provider: "disabled" },
    { ...role(), provider: "fixture-a", model: "synthetic-stt-v1" },
    { ...role(), model: "bulbul:v3" },
  ])
    expect(createSttRoleBinding(profile(), r).kind).toBe("denied");
  expect(
    createSttRoleBinding(profile(), { ...role(), model: "saaras:v4" }),
  ).toEqual({ kind: "denied", reason: "model_mismatch" });
  expect(
    createSttRoleBinding(profile(), {
      ...role(),
      provider: "elevenlabs",
      model: "scribe_v2",
    }),
  ).toEqual({ kind: "denied", reason: "provider_mismatch" });
  expect(
    createSttRoleBinding({ ...profile(), maxBytes: 2097152 }, role()),
  ).toEqual({ kind: "denied", reason: "media_contract_mismatch" });
});

test("policy language coverage must fit the actual role while unrelated roles cannot enter the binding", () => {
  expect(
    createSttRoleBinding(profile(), { ...role(), languages: ["ta-IN"] }),
  ).toEqual({ kind: "denied", reason: "language_mismatch" });
  for (const extra of [
    { apiKey: "synthetic-secret" },
    { purpose: "tts" },
    { providerLogging: "allow" },
    { approved: true },
  ])
    expect(createSttRoleBinding(profile(), { ...role(), ...extra }).kind).toBe(
      "denied",
    );
});

test("binding bytes and SHA match the independently generated Python fixture", () => {
  const result = createSttRoleBinding(reference.profile, reference.role);
  expect(result.kind).toBe("role_binding");
  if (result.kind !== "role_binding")
    throw Error("Expected synthetic identity");
  expect(result.canonicalJson).toBe(reference.canonicalJson);
  expect(result.contentSha256).toBe(reference.sha256);
  expect(
    createSttRoleBinding(
      { ...profile(), languages: ["hi-IN", "ta-IN", "en-IN"] },
      {
        timeoutMs: 20000,
        languages: ["hi-IN", "ta-IN", "en-IN", "ta-IN"],
        model: "saaras:v3",
        provider: "sarvam",
      },
    ),
  ).toEqual(result);
});

test("a consistent provider/model switch, timeout or effective cap changes identity without changing the source profile", () => {
  const p = profile(),
    r = role(),
    one = createSttRoleBinding(p, r);
  if (one.kind !== "role_binding") throw Error("Expected synthetic identity");
  const changes = [
    createSttRoleBinding(p, { ...r, timeoutMs: 1000 }),
    createSttRoleBinding(p, r, { requestCostMicros: 50 }),
    createSttRoleBinding(
      { ...p, price: { ...p.price, model: "saaras:v4" } },
      { ...r, model: "saaras:v4" },
    ),
    createSttRoleBinding(
      {
        ...p,
        price: { ...p.price, provider: "elevenlabs", model: "scribe_v2" },
      },
      { ...r, provider: "elevenlabs", model: "scribe_v2" },
    ),
    createSttRoleBinding(p, {
      ...r,
      languages: [...r.languages, "ml-IN", "kn-IN"],
    }),
  ];
  for (const changed of changes) {
    expect(changed.kind).toBe("role_binding");
    if (changed.kind !== "role_binding")
      throw Error("Expected reviewed metadata");
    expect(changed.contentSha256).not.toBe(one.contentSha256);
    expect(changed.executionAllowed).toBe(false);
  }
  p.price.model = "saaras:v4";
  r.timeoutMs = 1000;
  r.languages.splice(0);
  expect(one.role.timeoutMs).toBe(20000);
  expect(one.policy.profile.price.model).toBe("saaras:v3");
  expect(one.role.languages).toEqual(["en-IN", "hi-IN", "ta-IN"]);
  expect(Object.isFrozen(one)).toBe(true);
  expect(Object.isFrozen(one.policy.profile.price)).toBe(true);
  expect(
    createSttRoleBinding(profile(), role(), { requestCostMicros: 101 }).kind,
  ).toBe("denied");
});

test("strict role settings deny malformed time/language/model data and sanitize throwing accessors", () => {
  for (const timeoutMs of [0, 999, 60001, 1.5, NaN, Infinity, "20000", null])
    expect(createSttRoleBinding(profile(), { ...role(), timeoutMs }).kind).toBe(
      "denied",
    );
  for (const languages of [
    [],
    ["xx-IN"],
    ["ta-IN", "ta-IN", "ta-IN", "ta-IN", "ta-IN", "ta-IN"],
    null,
  ])
    expect(createSttRoleBinding(profile(), { ...role(), languages }).kind).toBe(
      "denied",
    );
  const hostile = {
    ...role(),
    get model(): string {
      throw Error("synthetic-private-message");
    },
  };
  expect(createSttRoleBinding(profile(), hostile)).toEqual({
    kind: "denied",
    reason: "invalid_input",
  });
  expect(
    createSttRoleBinding({ ...profile(), apiKey: "synthetic-secret" }, role())
      .kind,
  ).toBe("denied");
});

test("historical tariff content may be identified without asserting current price validity", () => {
  const p = profile();
  p.price.effectiveAt = 1000;
  p.price.expiresAt = 2000;
  const binding = createSttRoleBinding(p, role());
  expect(binding.kind).toBe("role_binding");
  if (binding.kind !== "role_binding") throw Error("Expected content identity");
  expect(binding.executionAllowed).toBe(false);
});

test("a matching binding and a key cannot activate the existing disabled vendor factory", async () => {
  const binding = createSttRoleBinding(profile(), role());
  if (binding.kind !== "role_binding") throw Error("Expected content identity");
  let calls = 0;
  const adapter = createSarvamStt({
    model: binding.role.model,
    apiKey: "synthetic-key",
    timeoutMs: binding.role.timeoutMs,
    languages: binding.role.languages,
    fetch: async () => {
      calls++;
      throw Error("No HTTP expected");
    },
  });
  await expect(
    adapter.transcribe({
      audio: syntheticSpeechFixture("ta-IN").audio,
      mimeType: "audio/wav",
      languageHint: "ta-IN",
      consentToProcess: true,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("disabled");
  expect(calls).toBe(0);
});
