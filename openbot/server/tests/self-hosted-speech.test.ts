import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { selfHostedConfig } from "../src/self-hosted/config";
import type {
  SpeechToTextProvider,
  Transcript,
} from "../src/self-hosted/speech";
import {
  createSpeech,
  syntheticSpeechFixture,
  validateFixtureTranscript,
} from "../src/self-hosted/speech";

test("the shared fixture transcript boundary rejects blank/forged evidence and preserves Indic text", async () => {
  const roles = selfHostedConfig({ SAATHI_STT_PROVIDER: "fixture-a" }).roles;
  const valid: Transcript = {
    text: " தமிழ் synthetic ",
    language: "ta-IN",
    confidence: null,
    alternatives: [],
    warnings: [],
    source: {
      mode: "fixture",
      provider: "fixture-a",
      model: "synthetic-stt-v1",
    },
  };
  expect(validateFixtureTranscript(valid, roles.stt).text).toBe(
    "தமிழ் synthetic",
  );
  for (const candidate of [
    { ...valid, text: " \n\t " },
    { ...valid, confidence: 0.9 },
    { ...valid, source: { ...valid.source, mode: "live" } },
    { ...valid, source: { ...valid.source, provider: "fixture-b" } },
    { ...valid, source: { ...valid.source, model: "unreviewed" } },
    { ...valid, language: "ml-IN" },
    { ...valid, grant: "execute" },
  ])
    expect(() => validateFixtureTranscript(candidate, roles.stt)).toThrow();
  const fake: SpeechToTextProvider = {
    transcribe: async () => ({ ...valid, text: "   " }),
  };
  await expect(
    createSpeech(roles, { stt: new Map([["fixture-a", fake]]) }).transcribe({
      audio: syntheticSpeechFixture("ta-IN").audio,
      mimeType: "audio/wav",
      consentToProcess: true,
    }),
  ).rejects.toMatchObject({ status: 502 });
});

test("fixture STT/TTS swap independently and label tones as synthetic rather than real speech", async () => {
  const first = selfHostedConfig({
    SAATHI_STT_PROVIDER: "fixture-a",
    SAATHI_TTS_PROVIDER: "fixture-b",
  });
  const second = selfHostedConfig({
    SAATHI_STT_PROVIDER: "fixture-b",
    SAATHI_TTS_PROVIDER: "fixture-b",
  });
  for (const language of ["en-IN", "hi-IN", "ta-IN"] as const) {
    const fixture = syntheticSpeechFixture(language);
    const a = createSpeech(first.roles),
      b = createSpeech(second.roles);
    const request = {
      audio: fixture.audio,
      mimeType: "audio/wav" as const,
      languageHint: language,
      consentToProcess: true as const,
    };
    const ta = await a.transcribe(request),
      tb = await b.transcribe(request);
    expect(ta.text).toBe(fixture.text);
    expect(tb.text).toBe(fixture.text);
    expect(ta.confidence).toBeNull();
    expect(tb.source.provider).toBe("fixture-b");
    expect(tb.source.mode).toBe("fixture");
    const aa = await a.synthesize({
        text: ta.text,
        language,
        consentToProcess: true,
      }),
      ab = await b.synthesize({
        text: tb.text,
        language,
        consentToProcess: true,
      });
    expect(aa.bytes).toEqual(ab.bytes);
    expect(aa.isSpeech).toBe(false);
    expect(aa.source.provider).toBe("fixture-b");
    expect(aa.mimeType).toBe("audio/wav");
    expect(new TextDecoder().decode(aa.bytes.slice(0, 4))).toBe("RIFF");
  }
  expect(first.roles.conversation).toEqual(second.roles.conversation);
});
test("unconfigured/live speech, unknown audio, missing consent and unsupported language fail explicitly", async () => {
  const fixture = syntheticSpeechFixture("en-IN");
  const request = {
    audio: fixture.audio,
    mimeType: "audio/wav" as const,
    languageHint: "en-IN" as const,
    consentToProcess: true as const,
  };
  await expect(
    createSpeech(selfHostedConfig({}).roles).transcribe(request),
  ).rejects.toThrow("disabled");
  await expect(
    createSpeech(
      selfHostedConfig({
        SAATHI_STT_PROVIDER: "sarvam",
        SAATHI_STT_MODEL: "operator-model",
      }).roles,
    ).transcribe(request),
  ).rejects.toThrow("not connected");
  const speech = createSpeech(
    selfHostedConfig({
      SAATHI_STT_PROVIDER: "fixture-a",
      SAATHI_TTS_PROVIDER: "fixture-b",
    }).roles,
  );
  await expect(
    speech.transcribe({ ...request, consentToProcess: false }),
  ).rejects.toThrow("consent");
  await expect(
    speech.transcribe({ ...request, audio: new Uint8Array(100) }),
  ).rejects.toThrow("synthetic fixture");
  await expect(
    speech.transcribe({ ...request, languageHint: "ml-IN" }),
  ).rejects.toThrow("language");
  await expect(
    speech.synthesize({
      text: "Synthetic",
      language: "kn-IN",
      consentToProcess: true,
    }),
  ).rejects.toThrow("language");
  await expect(
    speech.synthesize({ text: "", language: "en-IN", consentToProcess: true }),
  ).rejects.toThrow();
});
test("language hint does not replace fixture evidence, and TTS tones cannot masquerade as an input transcript", async () => {
  const speech = createSpeech(
      selfHostedConfig({
        SAATHI_STT_PROVIDER: "fixture-a",
        SAATHI_TTS_PROVIDER: "fixture-a",
      }).roles,
    ),
    fixture = syntheticSpeechFixture("ta-IN");
  const transcript = await speech.transcribe({
    audio: fixture.audio,
    mimeType: "audio/wav",
    languageHint: "en-IN",
    consentToProcess: true,
  });
  expect(transcript.language).toBe("ta-IN");
  expect(transcript.warnings.some((w) => w.includes("hint"))).toBe(true);
  const audio = await speech.synthesize({
    text: "Different text",
    language: "ta-IN",
    consentToProcess: true,
  });
  await expect(
    speech.transcribe({
      audio: audio.bytes,
      mimeType: "audio/wav",
      consentToProcess: true,
    }),
  ).rejects.toThrow("synthetic fixture");
});

test("an adapter timeout aborts once without fallback; misleading fixture identity is refused", async () => {
  const roles = selfHostedConfig({
    SAATHI_STT_PROVIDER: "fixture-a",
    SAATHI_STT_TIMEOUT_MS: "1000",
  }).roles;
  let calls = 0,
    receivedSignal: AbortSignal | undefined;
  const stalled: SpeechToTextProvider = {
    transcribe: async (input) => {
      calls++;
      receivedSignal = input.signal;
      return new Promise(() => {});
    },
  };
  const fixture = syntheticSpeechFixture("en-IN"),
    input = {
      audio: fixture.audio,
      mimeType: "audio/wav",
      consentToProcess: true,
    };
  const speech = createSpeech(roles, {
    stt: new Map([["fixture-a", stalled]]),
  });
  await expect(speech.transcribe(input)).rejects.toThrow("timed out");
  expect(calls).toBe(1);
  expect(receivedSignal?.aborted).toBe(true);
  const fake: SpeechToTextProvider = {
    transcribe: async () => ({
      text: "Synthetic",
      language: "en-IN",
      confidence: 0.99,
      alternatives: [],
      warnings: [],
      source: {
        mode: "live",
        provider: "fixture-a",
        model: "synthetic-stt-v1",
      },
    }),
  };
  await expect(
    createSpeech(roles, { stt: new Map([["fixture-a", fake]]) }).transcribe(
      input,
    ),
  ).rejects.toThrow("identity");
});

test("keyless fixture CLI ignores inherited private/cloud settings and reports only contract evidence", () => {
  const result = Bun.spawnSync(
    [
      process.execPath,
      resolve(import.meta.dir, "../../../scripts/saathi-role-check.ts"),
      "--fixture",
    ],
    {
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "synthetic-cli-private-key",
        INTELLIGENCE_API_KEY: "synthetic-cloud-key",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).not.toContain("synthetic-cli-private-key");
  expect(output).not.toContain("synthetic-cloud-key");
  const data = JSON.parse(output);
  expect(data.passed).toBe(6);
  expect(data.qualityBenchmark).toBe(false);
  expect(data.liveSpeechEnabled).toBe(false);
  expect(data.networkRequests).toBe(0);
  expect(
    data.cases.every(
      (row: { mode: string; outputIsSpeech: boolean }) =>
        row.mode === "fixture" && !row.outputIsSpeech,
    ),
  ).toBe(true);
});

test("TTS selection leaves STT/model roles unchanged and raw adapter errors are sanitized", async () => {
  const a = selfHostedConfig({
      SAATHI_STT_PROVIDER: "fixture-a",
      SAATHI_TTS_PROVIDER: "fixture-a",
    }),
    b = selfHostedConfig({
      SAATHI_STT_PROVIDER: "fixture-a",
      SAATHI_TTS_PROVIDER: "fixture-b",
    });
  expect(a.roles.stt).toEqual(b.roles.stt);
  expect(a.roles.reasoning).toEqual(b.roles.reasoning);
  const input = {
    text: "Synthetic test",
    language: "en-IN",
    consentToProcess: true,
  };
  const aa = await createSpeech(a.roles).synthesize(input),
    bb = await createSpeech(b.roles).synthesize(input);
  expect(Buffer.compare(aa.bytes, bb.bytes)).not.toBe(0);
  const fixture = syntheticSpeechFixture("en-IN"),
    request = {
      audio: fixture.audio,
      mimeType: "audio/wav",
      consentToProcess: true,
    };
  const broken: SpeechToTextProvider = {
    transcribe: async () => {
      throw new Error("synthetic-private-provider-error");
    },
  };
  await expect(
    createSpeech(a.roles, { stt: new Map([["fixture-a", broken]]) }).transcribe(
      request,
    ),
  ).rejects.toThrow("Speech adapter failed");
  await expect(
    createSpeech(a.roles).transcribe({ ...request, consentToProcess: false }),
  ).rejects.toMatchObject({ status: 403 });
});
