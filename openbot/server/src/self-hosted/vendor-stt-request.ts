import { z } from "zod";
import { LocalError } from "./errors";
import { speechLanguages } from "./roles";
import { vendorSttModels, vendorSttTimeoutSchema } from "./vendor-stt-contract";

const shared = {
  languageHint: z.enum(speechLanguages).nullish(),
  timeoutMs: vendorSttTimeoutSchema.default(20000),
};
const requestSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("sarvam"),
      model: z.enum(vendorSttModels.sarvam),
      providerLogging: z.never().optional(),
      ...shared,
    })
    .strict(),
  z
    .object({
      provider: z.literal("elevenlabs"),
      model: z.enum(vendorSttModels.elevenlabs),
      providerLogging: z.enum(["deny", "allow"]).default("deny"),
      ...shared,
    })
    .strict(),
]);
const iso = Object.freeze({
  "en-IN": "eng",
  "hi-IN": "hin",
  "ta-IN": "tam",
  "ml-IN": "mal",
  "kn-IN": "kan",
});

/** Exact existing wire options only: no audio, credentials, IO, eligibility check or execution authority. */
export function compileVendorSttRequest(input: unknown) {
  try {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid options");
    const r = parsed.data;
    const fields: Record<string, string> = {};
    let url: string;
    let credentialHeader: "api-subscription-key" | "xi-api-key";
    if (r.provider === "sarvam") {
      url = "https://api.sarvam.ai/speech-to-text";
      credentialHeader = "api-subscription-key";
      fields.model = r.model;
      if (r.model === "saaras:v3") fields.mode = "transcribe";
      fields.language_code = r.languageHint ?? "unknown";
      fields.with_timestamps = "false";
    } else {
      url = `https://api.elevenlabs.io/v1/speech-to-text?enable_logging=${r.providerLogging === "allow"}`;
      credentialHeader = "xi-api-key";
      fields.model_id = r.model;
      if (r.languageHint) fields.language_code = iso[r.languageHint];
      fields.diarize = "false";
      fields.tag_audio_events = "false";
      fields.timestamps_granularity = "none";
      fields.webhook = "false";
      fields.use_multi_channel = "false";
    }
    return Object.freeze({
      url,
      credentialHeader,
      timeoutMs: r.timeoutMs,
      fields: Object.freeze(fields),
    });
  } catch {
    throw new LocalError("Unsupported speech request options.");
  }
}
