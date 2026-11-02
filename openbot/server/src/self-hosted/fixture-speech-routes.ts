import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "./app";
import { LocalError } from "./errors";
import type { LocalFixtureSpeechRuntime } from "./fixture-speech-runtime";

const input = z
  .object({
    request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    consent_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
/** Register after parent host/session/CSRF/rate/JSON/security middleware. */
export function attachFixtureSpeech(
  app: Hono<{ Variables: AppVariables }>,
  options: {
    enabled?: boolean;
    publicOrigin?: string | null;
    runtime?: LocalFixtureSpeechRuntime;
    authenticate: (c: Context<{ Variables: AppVariables }>) => void;
  },
) {
  if (options.enabled !== true || options.publicOrigin) return false;
  const runtime = options.runtime;
  if (!runtime)
    throw new LocalError("Local fixture runtime is not configured.", 503);
  app.post("/api/media/:id/fixture-stt", async (c) => {
    const media = z.uuid().safeParse(c.req.param("id")),
      body = input.safeParse(c.var.body);
    if (!media.success || !body.success || new URL(c.req.url).search)
      throw new LocalError(
        "Use an owned media ID, request ID and exact consent revision only.",
      );
    const owner = c.var.session.owner;
    const result = await runtime.run(
      owner,
      { ...body.data, media_id: media.data },
      c.req.raw.signal,
    );
    options.authenticate(c);
    if (c.var.session.owner !== owner)
      throw new LocalError("Fixture workspace changed.", 403);
    return c.json(runtime.view(owner, result.id));
  });
  return true;
}
