import { expect, test } from "bun:test";
import { syntheticSpeechFixture } from "../src/self-hosted/speech";
import {
  createElevenLabsStt,
  createSarvamStt,
} from "../src/self-hosted/vendor-stt";
import { compileVendorSttRequest } from "../src/self-hosted/vendor-stt-request";

const sarvam = { provider: "sarvam", model: "saaras:v3" };
const eleven = { provider: "elevenlabs", model: "scribe_v2" };

test("compiler fixes credential-free endpoints, header names and exact minimal defaults", () => {
  expect(compileVendorSttRequest(sarvam)).toEqual({
    url: "https://api.sarvam.ai/speech-to-text",
    credentialHeader: "api-subscription-key",
    timeoutMs: 20000,
    fields: {
      model: "saaras:v3",
      mode: "transcribe",
      language_code: "unknown",
      with_timestamps: "false",
    },
  });
  expect(compileVendorSttRequest(eleven)).toEqual({
    url: "https://api.elevenlabs.io/v1/speech-to-text?enable_logging=false",
    credentialHeader: "xi-api-key",
    timeoutMs: 20000,
    fields: {
      model_id: "scribe_v2",
      diarize: "false",
      tag_audio_events: "false",
      timestamps_granularity: "none",
      webhook: "false",
      use_multi_channel: "false",
    },
  });
});

test("all reviewed language hints preserve exact existing provider mappings and null means auto", () => {
  for (const [languageHint, iso] of [
    ["en-IN", "eng"],
    ["hi-IN", "hin"],
    ["ta-IN", "tam"],
    ["ml-IN", "mal"],
    ["kn-IN", "kan"],
  ]) {
    expect(
      compileVendorSttRequest({ ...sarvam, languageHint }).fields.language_code,
    ).toBe(languageHint);
    expect(
      compileVendorSttRequest({ ...eleven, languageHint }).fields.language_code,
    ).toBe(iso);
  }
  for (const languageHint of [null, undefined]) {
    expect(
      compileVendorSttRequest({ ...sarvam, languageHint }).fields.language_code,
    ).toBe("unknown");
    expect(
      compileVendorSttRequest({ ...eleven, languageHint }).fields,
    ).not.toHaveProperty("language_code");
  }
  const v4 = compileVendorSttRequest({
    ...sarvam,
    model: "saaras:v4",
    timeoutMs: 1000,
  });
  expect(v4.fields).not.toHaveProperty("mode");
  expect(v4.timeoutMs).toBe(1000);
  expect(
    compileVendorSttRequest({
      ...eleven,
      providerLogging: "allow",
      timeoutMs: 60000,
    }).url,
  ).toEndWith("enable_logging=true");
});

test("unknown options, endpoints, credentials, paid additions and authority fields cannot enter the wire plan", () => {
  for (const extra of [
    { url: "https://synthetic.invalid" },
    { apiKey: "synthetic-private" },
    { headers: { token: "synthetic-private" } },
    { source_url: "https://synthetic.invalid/audio" },
    { token: "synthetic-private" },
    { webhook: true },
    { transcript_edit: "synthetic-private" },
    { keyterms: ["synthetic-private"] },
    { diarize: true },
    { enable_logging: true },
    { verified: true },
    { executionAllowed: true },
    { grant: "synthetic-private" },
  ]) {
    for (const base of [sarvam, eleven]) {
      const error = (() => {
        try {
          compileVendorSttRequest({ ...base, ...extra });
        } catch (error) {
          return error;
        }
      })();
      expect(String(error)).toBe("Error: Unsupported speech request options.");
      expect(String(error)).not.toContain("synthetic-private");
    }
  }
  for (const value of [
    null,
    undefined,
    [],
    { ...sarvam, model: "scribe_v2" },
    { ...eleven, model: "saaras:v4" },
    { ...eleven, languageHint: "unknown" },
    { ...eleven, timeoutMs: 999 },
    { ...eleven, timeoutMs: 60001 },
    { ...eleven, timeoutMs: NaN },
    { ...eleven, providerLogging: "auto" },
    { ...sarvam, providerLogging: "deny" },
    { ...sarvam, providerLogging: "allow" },
  ]) {
    expect(() => compileVendorSttRequest(value)).toThrow(
      "Unsupported speech request options.",
    );
  }
});

test("wire plans are detached and frozen; compiling neither authorizes nor performs IO", () => {
  const config = { ...eleven, languageHint: "ta-IN", providerLogging: "deny" };
  const plan = compileVendorSttRequest(config);
  config.model = "changed";
  config.languageHint = "hi-IN";
  config.providerLogging = "allow";
  expect(plan.fields.model_id).toBe("scribe_v2");
  expect(plan.fields.language_code).toBe("tam");
  expect(plan.url).toEndWith("enable_logging=false");
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.fields)).toBe(true);
  expect(() => Object.assign(plan.fields, { webhook: "true" })).toThrow();
  expect(plan).not.toHaveProperty("verified");
  expect(plan).not.toHaveProperty("grant");
});

test("compiled fields are exactly the fields sent by every existing factory variant", async () => {
  let calls = 0;
  for (const [provider, model, providerLogging] of [
    ["sarvam", "saaras:v3", undefined],
    ["sarvam", "saaras:v4", undefined],
    ["elevenlabs", "scribe_v2", "deny"],
    ["elevenlabs", "scribe_v2", "allow"],
  ] as const) {
    for (const languageHint of [
      undefined,
      "en-IN",
      "hi-IN",
      "ta-IN",
      "ml-IN",
      "kn-IN",
    ] as const) {
      const request = compileVendorSttRequest({
        provider,
        model,
        providerLogging,
        languageHint,
      });
      const options = {
        model,
        providerLogging,
        apiKey: "synthetic-wire-key",
        allowLiveRequests: true,
        languages: ["en-IN", "hi-IN", "ta-IN", "ml-IN", "kn-IN"] as const,
        fetch: async (url: string, init: RequestInit) => {
          calls++;
          expect(url).toBe(request.url);
          expect(init.redirect).toBe("error");
          expect(
            Object.fromEntries(new Headers(init.headers).entries()),
          ).toEqual({
            accept: "application/json",
            [request.credentialHeader]: "synthetic-wire-key",
          });
          const form = init.body as FormData;
          expect(
            Object.fromEntries(
              [...form.entries()].filter(([name]) => name !== "file"),
            ),
          ).toEqual(request.fields);
          expect([...form.keys()]).toHaveLength(
            Object.keys(request.fields).length + 1,
          );
          expect((form.get("file") as File).name).toBe("speech.wav");
          return Response.json(
            provider === "sarvam"
              ? {
                  transcript: "Synthetic",
                  language_code: languageHint ?? "en-IN",
                }
              : { text: "Synthetic", language_code: languageHint ?? "en-IN" },
          );
        },
      };
      const adapter =
        provider === "sarvam"
          ? createSarvamStt(options)
          : createElevenLabsStt(options);
      await adapter.transcribe({
        audio: syntheticSpeechFixture("en-IN").audio,
        mimeType: "audio/wav",
        languageHint,
        consentToProcess: true,
        signal: new AbortController().signal,
      });
    }
  }
  expect(calls).toBe(24);
});

test("zero-retention eligibility rejection cannot rewrite request options or retry logging-enabled", async () => {
  const urls: string[] = [];
  const adapter = createElevenLabsStt({
    model: "scribe_v2",
    apiKey: "synthetic-key",
    allowLiveRequests: true,
    fetch: async (url) => {
      urls.push(url);
      return new Response("synthetic-private-eligibility", { status: 403 });
    },
  });
  const failure = await adapter
    .transcribe({
      audio: syntheticSpeechFixture("en-IN").audio,
      mimeType: "audio/wav",
      consentToProcess: true,
      signal: new AbortController().signal,
    })
    .catch((error: unknown) => error);
  expect(urls).toEqual([compileVendorSttRequest(eleven).url]);
  expect(String(failure)).not.toContain("synthetic-private-eligibility");
});

test("throwing property access is sanitized without serializing private input", () => {
  const input = {
    ...eleven,
    get languageHint() {
      throw Error("synthetic-private-getter");
    },
  };
  expect(() => compileVendorSttRequest(input)).toThrow(
    "Unsupported speech request options.",
  );
});
