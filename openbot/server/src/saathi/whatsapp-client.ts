import { z } from "zod";

const BASE = "https://api.whatsapp.com/agent/v1";
const message = z.object({
  id: z.string().min(1).max(512),
  from: z.string().regex(/^user:\d+$/),
  timestamp: z.string().regex(/^\d+$/),
  type: z.string(),
  text: z.object({ body: z.string().max(100_000) }).optional(),
  audio: z
    .object({ id: z.string().max(512), mime_type: z.string().optional() })
    .optional(),
});
export type WhatsAppMessage = z.infer<typeof message>;
export type WhatsAppBatch = { nextOffset: number; messages: WhatsAppMessage[] };
type Transport = (url: string, init?: RequestInit) => Promise<Response>;

export class WhatsAppError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly ambiguous = false,
  ) {
    super(
      status === 429
        ? "WhatsApp rate limit reached; delivery will resume shortly."
        : status === 400 || status === 401
          ? "WhatsApp rejected this connection. Replace its agent token in Settings > Saathi."
          : ambiguous
            ? "WhatsApp delivery is uncertain. The message was not automatically sent again."
            : "WhatsApp could not process this request.",
    );
  }
}

export function createWhatsAppClient(
  token: string,
  transport: Transport = fetch,
) {
  async function request(path: string, init: RequestInit = {}, send = false) {
    let response: Response;
    try {
      response = await transport(`${BASE}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
        redirect: "error",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(35_000)])
          : AbortSignal.timeout(35_000),
      });
    } catch {
      throw new WhatsAppError(0, !send, send);
    }
    if (!response.ok) {
      // The manual guarantees non-acceptance only for 503 with error.code 131016.
      const knownUnsent =
        send &&
        response.status === 503 &&
        (await response.json().catch(() => null))?.error?.code === 131016;
      throw new WhatsAppError(
        response.status,
        response.status === 429 ||
          knownUnsent ||
          (!send && response.status >= 500),
        send && response.status >= 500 && !knownUnsent,
      );
    }
    return response;
  }
  return {
    async poll(offset: number, signal?: AbortSignal): Promise<WhatsAppBatch> {
      const response = await request(
        `/updates?offset=${offset}&limit=50&timeout=15`,
        { signal },
      );
      if (response.status === 204) return { nextOffset: offset, messages: [] };
      const parsed = z
        .object({
          next_offset: z.number().int().min(offset),
          entry: z.array(
            z.object({
              changes: z.array(
                z.object({
                  value: z.object({
                    messages: z.array(z.unknown()).default([]),
                  }),
                }),
              ),
            }),
          ),
        })
        .safeParse(await response.json());
      if (!parsed.success) throw new WhatsAppError(502, false);
      return {
        nextOffset: parsed.data.next_offset,
        messages: parsed.data.entry.flatMap((entry) =>
          entry.changes.flatMap((change) =>
            change.value.messages.flatMap((raw) => {
              const parsedMessage = message.safeParse(raw);
              return parsedMessage.success ? [parsedMessage.data] : [];
            }),
          ),
        ),
      };
    },
    async send(
      recipient: string,
      text: string,
      signal?: AbortSignal,
    ): Promise<string> {
      if (!/^user:\d+$/.test(recipient) || !text.length || text.length > 4096)
        throw new WhatsAppError(400, false);
      const response = await request(
        "/messages",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: recipient,
            type: "text",
            text: { body: text },
          }),
        },
        true,
      );
      const parsed = z
        .object({ messages: z.array(z.object({ id: z.string() })).min(1) })
        .safeParse(await response.json().catch(() => null));
      const messageId = parsed.success
        ? parsed.data.messages[0]?.id
        : undefined;
      if (!messageId) throw new WhatsAppError(502, false, true);
      return messageId;
    },
    async audio(mediaId: string, signal?: AbortSignal): Promise<File> {
      const response = await request(`/media/${encodeURIComponent(mediaId)}`, {
        signal,
      });
      const metadata = z
        .object({
          url: z.string().url(),
          mime_type: z.string(),
          file_size: z.number().optional(),
        })
        .parse(await response.json());
      const url = new URL(metadata.url);
      if (
        url.origin !== "https://lookaside.fbsbx.com" ||
        !url.pathname.startsWith("/agent/v1/media/") ||
        url.username ||
        url.password ||
        !metadata.mime_type.startsWith("audio/") ||
        (metadata.file_size ?? 0) > 10_000_000
      )
        throw new WhatsAppError(400, false);
      let media: Response;
      try {
        media = await transport(url.href, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000),
        });
      } catch {
        throw new WhatsAppError(0, true);
      }
      if (!media.ok || !media.body)
        throw new WhatsAppError(media.status, false);
      const chunks: Uint8Array[] = [];
      const reader = media.body.getReader();
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 10_000_000) throw new WhatsAppError(413, false);
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return new File(
        chunks.map((chunk) => new Uint8Array(chunk)),
        "voice.ogg",
        { type: metadata.mime_type },
      );
    },
  };
}

export function splitReply(text: string): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 4096) {
    const end = /[\uD800-\uDBFF]/.test(remaining.charAt(4095)) ? 4095 : 4096;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
