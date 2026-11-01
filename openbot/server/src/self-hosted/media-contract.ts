import { createHash } from "node:crypto";
import { z } from "zod";
import { LocalError } from "./errors";
import { speechLanguages } from "./roles";
import { inspectPcmWav } from "./wav";

export const maxMediaBytes = 2_000_000;

const upload = z
  .object({
    request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    audio: z
      .instanceof(Uint8Array)
      .refine((bytes) => bytes.length >= 44 && bytes.length <= maxMediaBytes),
    mimeType: z.literal("audio/wav"),
    consentToStore: z.literal(true),
    consentToProcess: z.boolean().optional().default(false),
    languageHint: z.enum(speechLanguages).nullish(),
  })
  .strict();
const contextSchema = z
  .object({
    owner: z.uuid(),
    now: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 900000),
    sessionExpiresAt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
type Context = z.infer<typeof contextSchema>;

/** Pure admission only. Caller must authenticate context; this neither stores nor sends audio. */
export function prepareMedia(context: Context, input: unknown) {
  const server = contextSchema.safeParse(context),
    parsed = upload.safeParse(input);
  if (!server.success || server.data.sessionExpiresAt <= server.data.now)
    throw new LocalError(
      "Media requires a valid unexpired owner session.",
      403,
    );
  if (!parsed.success)
    throw new LocalError(
      "Media requires explicit storage consent and bounded WAV input; client ownership, expiry, paths and URLs are not accepted.",
    );
  const audio = Uint8Array.from(parsed.data.audio),
    metadata = inspectPcmWav(audio),
    languageHint = parsed.data.languageHint ?? null,
    contentSha256 = createHash("sha256").update(audio).digest("hex"),
    requestDigest = createHash("sha256")
      .update(
        JSON.stringify({
          contentSha256,
          mimeType: "audio/wav",
          languageHint,
          consentToProcess: parsed.data.consentToProcess,
        }),
      )
      .digest("hex");
  return {
    owner: server.data.owner,
    request_id: parsed.data.request_id,
    audio,
    mimeType: "audio/wav" as const,
    byteLength: audio.length,
    durationMs: Math.ceil(metadata.durationMs),
    sampleRate: metadata.sampleRate,
    channels: metadata.channels,
    languageHint,
    consentToStore: true as const,
    consentToProcess: parsed.data.consentToProcess,
    contentSha256,
    requestDigest,
    createdAt: server.data.now,
    expiresAt: Math.min(server.data.now + 900000, server.data.sessionExpiresAt),
  };
}
