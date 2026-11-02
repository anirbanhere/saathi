import { expect, spyOn, test } from "bun:test";
import {
  createMetaModel,
  META_BASE_URL,
  verifyMetaModel,
} from "../src/saathi/meta";
import {
  createSaathiModels,
  type ModelKeyStore,
  type ModelProvider,
} from "../src/saathi/models";
import {
  completeForOwner,
  ownerRuntimeModel,
} from "../src/saathi/runtime-model";

function ownerModels() {
  const saved = new Map<
    string,
    { provider: ModelProvider; model: string; encryptedKey: string }
  >();
  const store: ModelKeyStore = {
    async save(owner, provider, value) {
      saved.set(owner, { ...value, provider });
    },
    async read(owner) {
      return saved.get(owner) ?? null;
    },
    async list() {
      return [];
    },
    async select() {
      return false;
    },
    async revoke(owner) {
      saved.delete(owner);
    },
  };
  return createSaathiModels(
    store,
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  );
}

test("Meta and OpenAI owners' helper requests never share destinations, keys, or environment", async () => {
  const models = ownerModels();
  await models.save("alice", {
    provider: "meta",
    model: "muse-spark-1.3",
    apiKey: "alice-meta-key",
  });
  await models.save("bob", {
    provider: "openai",
    model: "fixture-openai-model",
    apiKey: "bob-openai-key",
  });
  const calls: { url: string; key: string | null }[] = [];
  const originalBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://must-not-be-used.invalid/v1";
  const intercept = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        calls.push({
          url: String(input),
          key: new Headers(init?.headers).get("authorization"),
        });
        expect(init?.redirect).toBe("error");
        return Response.json({
          choices: [{ message: { content: '{"ok":true}' } }],
        });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    await Promise.all([
      completeForOwner(models, "alice", "Return JSON"),
      completeForOwner(models, "bob", "Return JSON"),
    ]);
    expect(calls).toContainEqual({
      url: `${META_BASE_URL}/chat/completions`,
      key: "Bearer alice-meta-key",
    });
    expect(calls).toContainEqual({
      url: "https://api.openai.com/v1/chat/completions",
      key: "Bearer bob-openai-key",
    });
    expect(process.env.OPENAI_BASE_URL).toBe(
      "https://must-not-be-used.invalid/v1",
    );
  } finally {
    intercept.mockRestore();
    if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = originalBase;
  }
});

test("revoking a Meta credential prevents an already-created runtime from dispatching another request", async () => {
  const models = ownerModels();
  await models.save("alice", {
    provider: "meta",
    model: "muse-spark-1.3",
    apiKey: "alice-meta-key",
  });
  const intercept = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("Revoked credentials must not be sent");
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    const runtime = await ownerRuntimeModel(models, "alice");
    await models.revoke("alice", "meta");
    await expect(
      runtime.model.client.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      }),
    ).rejects.toThrow("revoked or replaced");
    expect(intercept).not.toHaveBeenCalled();
  } finally {
    intercept.mockRestore();
  }
});

test("Meta model verification sends the key only to Meta and refuses redirects", async () => {
  const request: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.meta.ai/v1/models/muse-spark-1.3",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-meta-key",
      );
      expect(init?.redirect).toBe("error");
      return Response.json({ id: "muse-spark-1.3", object: "model" });
    },
    { preconnect: fetch.preconnect },
  );
  await expect(
    verifyMetaModel("muse-spark-1.3", "synthetic-meta-key", request),
  ).resolves.toBeUndefined();
  await expect(
    verifyMetaModel(
      "muse-spark-1.3",
      "synthetic-meta-key",
      Object.assign(
        async () =>
          Response.json({ error: "private upstream error" }, { status: 401 }),
        { preconnect: fetch.preconnect },
      ),
    ),
  ).rejects.toThrow("verify access");
});

test("Muse streaming text reaches the caller through the Meta endpoint", async () => {
  const request: typeof fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.stream).toBe(true);
      expect(payload.store).toBe(false);
      const events = [
        {
          type: "response.created",
          response: {
            id: "resp_stream",
            created_at: 1,
            model: "muse-spark-1.3",
          },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_stream" },
        },
        {
          type: "response.output_text.delta",
          item_id: "msg_stream",
          delta: "Hello from Muse",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_stream",
            content: [
              { type: "output_text", text: "Hello from Muse", annotations: [] },
            ],
          },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_stream",
            status: "completed",
            usage: { input_tokens: 2, output_tokens: 3 },
          },
        },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const result = await createMetaModel(
    "muse-spark-1.3",
    "synthetic-meta-key",
    request,
  ).doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
  });
  const parts = [];
  for await (const part of result.stream) parts.push(part);
  expect(parts.filter((part) => part.type === "error")).toEqual([]);
  expect(parts).toContainEqual(
    expect.objectContaining({ type: "text-delta", delta: "Hello from Muse" }),
  );
});

test("Muse generation uses Meta Responses with stateless encrypted reasoning and tools", async () => {
  let payload: Record<string, unknown> | undefined;
  const request: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.meta.ai/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-meta-key",
      );
      expect(init?.redirect).toBe("error");
      payload = JSON.parse(String(init?.body));
      return Response.json({
        id: "resp_fixture",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "muse-spark-1.3",
        output: [
          {
            id: "fc_fixture",
            type: "function_call",
            call_id: "call_fixture",
            name: "lookup",
            arguments: '{"query":"meal plan"}',
            status: "completed",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      });
    },
    { preconnect: fetch.preconnect },
  );
  const model = createMetaModel(
    "muse-spark-1.3",
    "synthetic-meta-key",
    request,
  );
  const result = await model.doGenerate({
    prompt: [
      { role: "user", content: [{ type: "text", text: "Find a meal plan" }] },
    ],
    tools: [
      {
        type: "function",
        name: "lookup",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
    maxOutputTokens: 1024,
  });
  expect(payload?.model).toBe("muse-spark-1.3");
  expect(payload?.store).toBe(false);
  expect(payload?.include).toContain("reasoning.encrypted_content");
  expect(payload?.tools).toMatchObject([{ type: "function", name: "lookup" }]);
  expect(result.content).toContainEqual(
    expect.objectContaining({
      type: "tool-call",
      toolName: "lookup",
      toolCallId: "call_fixture",
    }),
  );
});
