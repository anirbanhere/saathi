import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "./app";
import { LocalError } from "./errors";
import { maxMediaBytes } from "./media-contract";
import type { OwnedMedia } from "./media-store";
import { speechLanguages } from "./roles";

export const localMediaUploadPath = "/api/media/upload";
const metadata = z.object({
  request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  store: z.literal("true"),
  process: z.enum(["true", "false"]).optional().default("false"),
  language: z.enum(speechLanguages).optional(),
});
const allowedHeaders = new Set([
  "x-saathi-csrf",
  "x-saathi-request-id",
  "x-saathi-consent-store",
  "x-saathi-consent-process",
  "x-saathi-language",
]);
function uploadMetadata(request: Request) {
  for (const name of request.headers.keys()) {
    if (
      (name.startsWith("x-saathi-") && !allowedHeaders.has(name)) ||
      name === "content-disposition" ||
      name === "content-encoding"
    )
      throw new LocalError("Unsupported upload metadata.");
  }
  if (new URL(request.url).search)
    throw new LocalError("Uploads accept no query fields.");
  const field = (name: string) => request.headers.get(name) ?? undefined;
  const parsed = metadata.safeParse({
    request_id: field("x-saathi-request-id"),
    store: field("x-saathi-consent-store"),
    process: field("x-saathi-consent-process"),
    language: field("x-saathi-language"),
  });
  if (!parsed.success)
    throw new LocalError(
      "Use explicit storage consent, a request ID and supported upload metadata.",
    );
  return parsed.data;
}

async function readUpload(request: Request) {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maxMediaBytes)
  )
    throw new LocalError("Upload exceeds2MB or has an invalid length.", 413);
  if (request.signal.aborted)
    throw new LocalError("Upload interrupted or timed out.", 408);
  const reader = request.body?.getReader();
  if (!reader) throw new LocalError("Use a bounded PCM16 WAV body.");
  let interrupted = false,
    size = 0;
  const chunks: Uint8Array[] = [];
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    void reader.cancel().catch(() => {});
  };
  const timer = setTimeout(interrupt, 15_000);
  request.signal.addEventListener("abort", interrupt, { once: true });
  try {
    if (request.signal.aborted) interrupt();
    for (;;) {
      const { value, done } = await reader.read();
      if (interrupted)
        throw new LocalError("Upload interrupted or timed out.", 408);
      if (done) break;
      size += value.length;
      if (size > maxMediaBytes) {
        void reader.cancel().catch(() => {});
        throw new LocalError("Upload exceeds2MB.", 413);
      }
      chunks.push(value);
    }
    if (declared !== null && Number(declared) !== size)
      throw new LocalError("Upload length does not match its body.", 400);
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof LocalError) throw error;
    throw new LocalError("Upload could not be read.", 400);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", interrupt);
    reader.releaseLock();
  }
}

/** The parent authenticates same-origin/session/CSRF and rate limits before body admission. */
export function attachLocalMediaUpload(
  app: Hono<{ Variables: AppVariables }>,
  options: {
    media: OwnedMedia;
    enabled?: boolean;
    publicOrigin?: string | null;
    authenticate: (c: Context<{ Variables: AppVariables }>) => void;
  },
) {
  if (options.enabled !== true || options.publicOrigin) return;
  const active = new Set<string>();
  app.post(localMediaUploadPath, async (c) => {
    const input = uploadMetadata(c.req.raw),
      owner = c.var.session.owner;
    if (active.has(owner) || active.size >= 4)
      throw new LocalError("Local upload capacity is busy.", 429);
    active.add(owner);
    try {
      const audio = await readUpload(c.req.raw);
      if (c.req.raw.signal.aborted)
        throw new LocalError("Upload interrupted or timed out.", 408);
      options.authenticate(c);
      if (c.var.session.owner !== owner)
        throw new LocalError("Upload workspace changed.", 403);
      const saved = options.media.admit(owner, {
        request_id: input.request_id,
        audio,
        mimeType: "audio/wav",
        consentToStore: true,
        consentToProcess: input.process === "true",
        languageHint: input.language,
      });
      return c.json(saved);
    } finally {
      active.delete(owner);
    }
  });
}
