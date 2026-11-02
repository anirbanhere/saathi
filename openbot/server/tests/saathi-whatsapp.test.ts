import { describe, expect, test } from "bun:test";
import {
  createWhatsAppClient,
  WhatsAppError,
  splitReply,
} from "../src/saathi/whatsapp-client";

describe("official WhatsApp Agent Platform transport", () => {
  test("uses the official origin and carries the durable cursor without exposing the token", async () => {
    const client = createWhatsAppClient("private-token", async (url, init) => {
      expect(String(url)).toBe(
        "https://api.whatsapp.com/agent/v1/updates?offset=42&limit=50&timeout=15",
      );
      expect(init?.headers).toEqual({ authorization: "Bearer private-token" });
      expect(init?.redirect).toBe("error");
      return Response.json({
        next_offset: 43,
        entry: [
          {
            id: "agent-1",
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: "wamid.1",
                      from: "user:123",
                      timestamp: "1793290000",
                      type: "text",
                      text: { body: "hello" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
    });
    const result = await client.poll(42);
    expect(result.nextOffset).toBe(43);
    expect(result.messages[0]?.from).toBe("user:123");
  });
  test("empty polls retain the cursor", async () => {
    const client = createWhatsAppClient(
      "token",
      async () => new Response(null, { status: 204 }),
    );
    expect(await client.poll(42)).toEqual({ nextOffset: 42, messages: [] });
  });
  test("timeouts and server errors are uncertain sends and never leak response bodies", async () => {
    for (const fetcher of [
      async () =>
        Response.json(
          { error: { message: "secret echoed private-token" } },
          { status: 500 },
        ),
      async () =>
        Response.json(
          { error: { message: "uncertain proxy failure" } },
          { status: 503 },
        ),
      async () => {
        throw new Error("private-token at network endpoint");
      },
    ]) {
      const client = createWhatsAppClient("private-token", fetcher);
      try {
        await client.send("user:123", "hello");
        throw new Error("should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(WhatsAppError);
        expect((error as WhatsAppError).ambiguous).toBe(true);
        expect((error as Error).message).not.toContain("private-token");
      }
    }
  });
  test("retries 503 only when the documented error explicitly means not accepted", async () => {
    const client = createWhatsAppClient("token", async () =>
      Response.json({ error: { code: 131016 } }, { status: 503 }),
    );
    try {
      await client.send("user:123", "hello");
      throw new Error("should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WhatsAppError);
      expect((error as WhatsAppError).retryable).toBe(true);
      expect((error as WhatsAppError).ambiguous).toBe(false);
    }
  });
  test("rate limits are retryable; invalid tokens are not", async () => {
    for (const status of [429, 400, 401, 403]) {
      const client = createWhatsAppClient(
        "token",
        async () => new Response(null, { status }),
      );
      try {
        await client.send("user:123", "hello");
      } catch (error) {
        expect((error as WhatsAppError).retryable).toBe(status === 429);
      }
    }
  });
  test("refuses arbitrary recipients and untrusted media hosts before forwarding credentials", async () => {
    let calls = 0;
    const client = createWhatsAppClient("token", async () => {
      calls++;
      return Response.json({
        url: "https://evil.invalid/file",
        mime_type: "audio/ogg",
      });
    });
    await expect(client.send("+919000000000", "hello")).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(client.audio("media-1")).rejects.toThrow();
    expect(calls).toBe(1);
  });
  test("splits long replies without dropping text or splitting surrogate pairs", () => {
    const value = "Hello 😀 ".repeat(900);
    const parts = splitReply(value);
    expect(parts.join("")).toBe(value);
    expect(parts.every((part) => part.length <= 4096)).toBe(true);
    expect(parts.every((part) => !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });
});
