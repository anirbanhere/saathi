import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import {
  createSaathiModels,
  type ModelKeyStore,
  type ModelProvider,
} from "../src/saathi/models";
import { createSaathiRoutes } from "../src/saathi/routes";

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
  async list(owner) {
    const value = saved.get(owner);
    return value
      ? [{ provider: value.provider, model: value.model, selected: true }]
      : [];
  },
  async select(owner, provider, model) {
    const value = saved.get(owner);
    if (!value || value.provider !== provider) return false;
    saved.set(owner, { ...value, model });
    return true;
  },
  async revoke(owner) {
    saved.delete(owner);
  },
};
const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  const id = context.req.header("test-owner");
  if (!id) return context.json({ error: "Authentication required." }, 401);
  context.set("actor", { id, email: `${id}@test.invalid`, role: "user" });
  await next();
};
const app = createSaathiRoutes(
  {
    models: createSaathiModels(
      store,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ),
    connections: {
      async get() {
        return null;
      },
      async disconnect() {},
    },
    async connect() {
      throw new Error("not used");
    },
    async validateModel() {},
    speechConfigured: false,
  },
  requireUser,
);

test("model endpoints require authentication and never return secrets", async () => {
  expect((await app.request("/status")).status).toBe(401);
  const result = await app.request("/model-key", {
    method: "POST",
    headers: { "content-type": "application/json", "test-owner": "alice" },
    body: JSON.stringify({
      provider: "openai",
      model: "test-model",
      apiKey: "private-key",
    }),
  });
  expect(result.status).toBe(200);
  expect(await result.text()).not.toContain("private-key");
  const alice = await app.request("/status", {
    headers: { "test-owner": "alice" },
  });
  expect((await alice.json()).models).toEqual([
    { provider: "openai", model: "test-model", selected: true },
  ]);
  const bob = await app.request("/status", {
    headers: { "test-owner": "bob" },
  });
  expect((await bob.json()).models).toEqual([]);
});
test("request bodies cannot select another owner and errors cannot expose keys", async () => {
  const result = await app.request("/model-key", {
    method: "POST",
    headers: { "content-type": "application/json", "test-owner": "alice" },
    body: JSON.stringify({
      provider: "openai",
      model: "test-model",
      apiKey: "another-secret",
      owner: "bob",
    }),
  });
  expect(result.status).toBe(400);
  expect(await result.text()).not.toContain("another-secret");
});

test("Meta keys use the authenticated owner and remain write-only", async () => {
  const result = await app.request("/model-key", {
    method: "POST",
    headers: { "content-type": "application/json", "test-owner": "meta-owner" },
    body: JSON.stringify({
      provider: "meta",
      model: "muse-spark-1.3",
      apiKey: "synthetic-meta-secret",
    }),
  });
  expect(result.status).toBe(200);
  const status = await app.request("/status", {
    headers: { "test-owner": "meta-owner" },
  });
  const body = await status.text();
  expect(body).not.toContain("synthetic-meta-secret");
  expect(JSON.parse(body).models).toEqual([
    { provider: "meta", model: "muse-spark-1.3", selected: true },
  ]);
});
