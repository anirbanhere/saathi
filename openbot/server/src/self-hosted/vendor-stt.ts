import { z } from "zod";
import { LocalError } from "./errors";
import type { ProviderFetch } from "./http-json";
import {
  fixtureLanguages,
  type SpeechLanguage,
  speechLanguages,
} from "./roles";
import {
  parseSttInput,
  type SpeechToTextProvider,
  type Transcript,
} from "./speech";
import { speechJson } from "./speech-http";
import {
  vendorSttBounds,
  vendorSttLanguagesSchema,
  vendorSttModels,
  vendorSttTimeoutSchema,
} from "./vendor-stt-contract";
import { inspectPcmWav } from "./wav";

type Options = {
  model: string;
  apiKey?: string;
  allowLiveRequests?: boolean;
  timeoutMs?: number;
  languages?: readonly SpeechLanguage[];
  fetch?: ProviderFetch;
  providerLogging?: "deny" | "allow";
};
const locale = z.enum(speechLanguages);
const transcript = z.object({
  text: z.string().trim().min(1).max(2000),
  language_code: z.string().nullable(),
});
const iso: Record<SpeechLanguage, string> = {
  "en-IN": "eng",
  "hi-IN": "hin",
  "ta-IN": "tam",
  "ml-IN": "mal",
  "kn-IN": "kan",
};
const locales: Record<string, SpeechLanguage> = {
  eng: "en-IN",
  en: "en-IN",
  hin: "hi-IN",
  hi: "hi-IN",
  tam: "ta-IN",
  ta: "ta-IN",
  mal: "ml-IN",
  ml: "ml-IN",
  kan: "kn-IN",
  kn: "kn-IN",
};

/** Internal-only factories. They are not registered with public/fixture speech routes. */
function createStt(
  provider: "sarvam" | "elevenlabs",
  options: Options,
): SpeechToTextProvider {
  if (!vendorSttModels[provider].some((model) => model === options.model))
    throw new LocalError("Unsupported speech provider model.");
  if (provider === "sarvam" && options.providerLogging !== undefined)
    throw new LocalError(
      "No Sarvam retention-control option has been verified.",
    );
  const languages = vendorSttLanguagesSchema.parse([
    ...(options.languages ?? fixtureLanguages),
  ]);
  const timeout = options.timeoutMs ?? 20000;
  if (!vendorSttTimeoutSchema.safeParse(timeout).success)
    throw new LocalError("Unsupported speech timeout budget.");
  if (
    options.providerLogging !== undefined &&
    !["deny", "allow"].includes(options.providerLogging)
  )
    throw new LocalError("Unsupported speech retention policy.");
  const key = options.apiKey?.trim(),
    model = options.model,
    logging = options.providerLogging ?? "deny";
  const enabled = options.allowLiveRequests === true,
    call = options.fetch ?? fetch;
  return {
    async transcribe(input): Promise<Transcript> {
      if (!enabled)
        throw new LocalError("This live speech adapter is disabled.", 503);
      if (!key || key.length > 1000 || /[\r\n]/.test(key))
        throw new LocalError(
          "Configure this speech provider's server key.",
          503,
        );
      if (!input || !(input.signal instanceof AbortSignal))
        throw new LocalError("Speech requires a valid cancellation signal.");
      if (input.signal.aborted)
        throw new LocalError("Speech request was aborted.", 408);
      const { signal, ...raw } = input,
        parsed = parseSttInput(raw);
      if (parsed.languageHint && !languages.includes(parsed.languageHint))
        throw new LocalError("Selected speech language is not enabled.");
      const audio = Uint8Array.from(parsed.audio);
      const wav = inspectPcmWav(audio);
      if (
        wav.durationMs < vendorSttBounds.minDurationMs ||
        wav.durationMs > vendorSttBounds.maxDurationMs
      )
        throw new LocalError(
          "Vendor STT accepts WAV audio from 100ms through 29 seconds in this slice.",
        );
      const form = new FormData();
      form.append(
        "file",
        new File([audio], "speech.wav", {
          type: "audio/wav",
        }),
      );
      let url: string;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (provider === "sarvam") {
        url = "https://api.sarvam.ai/speech-to-text";
        headers["api-subscription-key"] = key;
        form.set("model", model);
        if (model === "saaras:v3") form.set("mode", "transcribe");
        form.set("language_code", parsed.languageHint ?? "unknown");
        form.set("with_timestamps", "false");
      } else {
        url = `https://api.elevenlabs.io/v1/speech-to-text?enable_logging=${logging === "allow"}`;
        headers["xi-api-key"] = key;
        form.set("model_id", model);
        if (parsed.languageHint)
          form.set("language_code", iso[parsed.languageHint]);
        form.set("diarize", "false");
        form.set("tag_audio_events", "false");
        form.set("timestamps_granularity", "none");
        form.set("webhook", "false");
        form.set("use_multi_channel", "false");
      }
      const response = await speechJson(
        call,
        url,
        { method: "POST", headers, body: form },
        signal,
        timeout,
      );
      const adapted =
        provider === "sarvam" && response && typeof response === "object"
          ? {
              ...response,
              text: (response as Record<string, unknown>).transcript,
            }
          : response;
      const result = transcript.safeParse(adapted);
      if (!result.success)
        throw new LocalError(
          "Speech provider returned an invalid transcript.",
          502,
        );
      const reported = result.data.language_code;
      const language =
        reported && (locales[reported] ?? locale.safeParse(reported).data);
      if (!language || !languages.includes(language))
        throw new LocalError(
          "Speech provider returned an unsupported or unknown language; review the audio manually.",
          502,
        );
      return {
        text: result.data.text,
        language,
        confidence: null,
        alternatives: [],
        source: { mode: "live", provider, model },
        warnings: [
          "Provider-reported transcript; confirm critical names, dates and amounts. Transcription confidence unavailable.",
          "Provider processing/retention terms apply; no independent deletion or language-quality guarantee.",
          ...(parsed.languageHint && parsed.languageHint !== language
            ? ["The provider language differs from the requested hint."]
            : []),
        ],
      };
    },
  };
}
export const createSarvamStt = (options: Options) =>
  createStt("sarvam", options);
export const createElevenLabsStt = (options: Options) =>
  createStt("elevenlabs", options);
