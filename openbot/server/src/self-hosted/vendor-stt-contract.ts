import { z } from "zod";
import { speechLanguages } from "./roles";
import { pcmWavMaxBytes } from "./wav";

/** Existing reviewed wire allowlist only, not a live provider catalogue or access grant. */
export const vendorSttModels = Object.freeze({
  sarvam: Object.freeze(["saaras:v3", "saaras:v4"] as const),
  elevenlabs: Object.freeze(["scribe_v2"] as const),
});
export const vendorSttBounds = Object.freeze({
  maxBytes: pcmWavMaxBytes,
  minDurationMs: 100,
  maxDurationMs: 29000,
});
export const vendorSttLanguagesSchema = z
  .array(z.enum(speechLanguages))
  .min(1)
  .max(5);
export const vendorSttTimeoutSchema = z.number().int().min(1000).max(60000);
const settings = {
  languages: vendorSttLanguagesSchema,
  timeoutMs: vendorSttTimeoutSchema,
};
export const vendorSttRoleSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("sarvam"),
      model: z.enum(vendorSttModels.sarvam),
      ...settings,
    })
    .strict(),
  z
    .object({
      provider: z.literal("elevenlabs"),
      model: z.enum(vendorSttModels.elevenlabs),
      ...settings,
    })
    .strict(),
]);
