import { timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { attachFixtureSpeech } from "./fixture-speech-routes";
import type { LocalFixtureSpeechRuntime } from "./fixture-speech-runtime";
import { attachLocalMediaControls } from "./media-routes";
import { attachLocalMediaUpload, localMediaUploadPath } from "./media-upload";
import type { ModelCatalog, ModelChoice } from "./models";
import { attachPlanRoutes, type Planner } from "./planner";
import {
  type ModelPurpose,
  type ProviderRoles,
  roleDiagnostics,
} from "./roles";
import type { GroundedAnswer } from "./search";
import { LocalError, type SelfHostedStore, type StoredMessage } from "./store";

export type AnswerInput = {
  agent: string;
  messages: StoredMessage[];
  memories: string[];
  runId: string;
  threadId: string;
  model?: ModelChoice;
  purpose?: ModelPurpose;
  directive?: string;
};
type Session = { owner: string; csrf: string };
export type AppVariables = { session: Session; body: unknown };
const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createSelfHostedApp(options: {
  store: SelfHostedStore;
  answer: (input: AnswerInput) => Promise<string | GroundedAnswer>;
  model: string;
  models?: () => Promise<ModelCatalog>;
  publicOrigin?: string | null;
  roles?: ProviderRoles;
  planner?: Planner;
  localMediaControls?: boolean;
  localMediaUploads?: boolean;
  localFixtureSpeech?: boolean;
  fixtureSpeech?: LocalFixtureSpeechRuntime;
}) {
  const { store, answer, model } = options;
  const getModels =
    options.models ??
    (async () => ({
      models: [
        {
          id: `openrouter:${model}`,
          provider: "openrouter" as const,
          model,
          name: model,
          inputPerMillion: 0,
          outputPerMillion: 0,
        },
      ],
      defaultModel: `openrouter:${model}`,
      allowPaid: false,
      metaEnabled: false,
      maxInputPrice: 0,
      maxOutputPrice: 0,
      checkedAt: Date.now(),
      issues: [],
    }));
  const app = new Hono<{ Variables: AppVariables }>();
  const localMediaUploads =
    options.localMediaUploads === true && !options.publicOrigin;
  const authenticate = (c: Context<{ Variables: AppVariables }>) => {
    const session = store.session(getCookie(c, "saathi_self_hosted") ?? "");
    if (!session) throw new LocalError("Start a private local workspace.", 401);
    if (
      c.req.method !== "GET" &&
      !equal(c.req.header("x-saathi-csrf") ?? "", session.csrf)
    )
      throw new LocalError("Invalid action token.", 403);
    c.set("session", session);
  };
  const writes: number[] = [];
  app.onError((error, c) =>
    c.json(
      {
        error: {
          message:
            error instanceof LocalError
              ? error.message
              : "Local storage is unavailable. No external action was executed.",
        },
      },
      (error instanceof LocalError
        ? error.status
        : 503) as ContentfulStatusCode,
    ),
  );
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(securityHeaders))
      c.header(name, value);
    const url = new URL(c.req.url);
    const expectedOrigin = options.publicOrigin ?? url.origin;
    if (options.publicOrigin) {
      if (url.host !== new URL(options.publicOrigin).host)
        throw new LocalError("Unrecognized public host.", 403);
      c.header("Strict-Transport-Security", "max-age=86400");
    } else if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new LocalError("This Saathi mode is loopback-only.", 403);
    if (!["GET", "POST", "DELETE"].includes(c.req.method))
      throw new LocalError("Unsupported method.", 405);
    const uploadRequest =
      localMediaUploads &&
      c.req.method === "POST" &&
      url.pathname === localMediaUploadPath;
    if (c.req.method !== "GET") {
      if (
        c.req.header("origin") !== expectedOrigin ||
        (uploadRequest
          ? c.req.header("content-type") !== "audio/wav"
          : c.req.header("content-type")?.split(";")[0] !== "application/json")
      )
        throw new LocalError(
          uploadRequest
            ? "Use same-origin WAV upload."
            : "Use same-origin JSON.",
          403,
        );
      const now = Date.now();
      while (writes.length && (writes[0] ?? now) < now - 60_000) writes.shift();
      if (writes.length >= 100)
        throw new LocalError("Local request budget reached.", 429);
      writes.push(now);
      if (uploadRequest) authenticate(c);
      else {
        const declared = c.req.header("content-length");
        if (declared && (!/^\d+$/.test(declared) || Number(declared) > 60_000))
          throw new LocalError("Request exceeds60KB.", 413);
        const reader = c.req.raw.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > 60_000) {
                await reader.cancel();
                throw new LocalError("Request exceeds60KB.", 413);
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        try {
          c.set("body", JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          throw new LocalError("Invalid JSON.", 400);
        }
      }
    }
    if (
      !uploadRequest &&
      url.pathname.startsWith("/api/") &&
      !(url.pathname === "/api/session" && c.req.method === "POST")
    ) {
      authenticate(c);
    }
    await next();
    // Raw file Responses do not inherit the Context's prepared response headers.
    for (const [name, value] of Object.entries(securityHeaders))
      c.res.headers.set(name, value);
    if (options.publicOrigin)
      c.res.headers.set("Strict-Transport-Security", "max-age=86400");
  });
  const input = <T>(schema: z.ZodType<T>, body: unknown) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new LocalError("Invalid or unsupported request fields.");
    return parsed.data;
  };
  attachPlanRoutes(app, { ...options, models: getModels });
  const localMediaControls = attachLocalMediaControls(app, {
    media: store.media,
    enabled: options.localMediaControls,
    publicOrigin: options.publicOrigin,
  });
  attachLocalMediaUpload(app, {
    media: store.media,
    enabled: options.localMediaUploads,
    publicOrigin: options.publicOrigin,
    authenticate,
  });
  const fixtureSpeech = attachFixtureSpeech(app, {
    enabled: options.localFixtureSpeech,
    publicOrigin: options.publicOrigin,
    runtime: options.fixtureSpeech,
    authenticate,
  });
  app.get("/health", (c) =>
    c.json({
      storage: "self-hosted-sqlite",
      actions: false,
      speech: false,
      fixture_speech: fixtureSpeech,
      local_media_controls: localMediaControls,
      local_media_uploads: localMediaUploads,
      demo_appointments: true,
      task_planning: Boolean(options.roles && options.planner),
      general_task_execution: false,
      native_read_steps: true,
      model,
      public_demo: Boolean(options.publicOrigin),
      daily_limits: store.limits(),
    }),
  );
  app.post("/api/session", (c) => {
    input(z.object({ consent: z.literal(true) }).strict(), c.var.body);
    const session = store.createSession();
    setCookie(c, "saathi_self_hosted", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 86400,
      secure: Boolean(options.publicOrigin),
    });
    return c.json(
      {
        csrf: session.csrf,
        storage: "self-hosted-sqlite",
        model,
        daily_limits: store.limits(),
      },
      201,
    );
  });
  app.get("/api/session", (c) =>
    c.json({
      csrf: c.var.session.csrf,
      storage: "self-hosted-sqlite",
      model,
      daily_limits: store.limits(),
    }),
  );
  app.get("/api/threads", (c) =>
    c.json(
      store
        .listThreads(c.var.session.owner)
        .map(({ owner: _owner, ...thread }) => thread),
    ),
  );
  app.get("/api/models", async (c) => c.json(await getModels()));
  app.get("/api/provider-roles", (c) =>
    c.json(
      options.roles
        ? roleDiagnostics(options.roles)
        : {
            configured: false,
            liveSpeechEnabled: false,
            publicAudioEnabled: false,
          },
    ),
  );
  app.get("/api/demo-appointments/options", (c) =>
    c.json(store.appointments.options(c.req.query("date"))),
  );
  app.get("/api/demo-appointments", (c) =>
    c.json(store.appointments.list(c.var.session.owner)),
  );
  app.post("/api/demo-appointments", (c) =>
    c.json(store.appointments.create(c.var.session.owner, c.var.body), 201),
  );
  app.get("/api/demo-appointments/:id", (c) =>
    c.json(store.appointments.get(c.var.session.owner, c.req.param("id"))),
  );
  app.post("/api/demo-appointments/:id/preview", (c) =>
    c.json(
      store.appointments.preview(
        c.var.session.owner,
        c.req.param("id"),
        c.var.body,
      ),
    ),
  );
  app.post("/api/demo-appointments/:id/decision", (c) =>
    c.json(
      store.appointments.decide(
        c.var.session.owner,
        c.req.param("id"),
        c.var.body,
      ),
    ),
  );
  app.post("/api/demo-appointments/:id/cancel", (c) => {
    const body = input(
      z.object({ version: z.number().int().min(1).max(100) }).strict(),
      c.var.body,
    );
    return c.json(
      store.appointments.cancel(
        c.var.session.owner,
        c.req.param("id"),
        body.version,
      ),
    );
  });
  app.post("/api/threads", (c) => {
    const body = input(
      z.object({ agent: z.enum(["saathi", "kitchen", "inventory"]) }).strict(),
      c.var.body,
    );
    const { owner: _owner, ...thread } = store.createThread(
      c.var.session.owner,
      body.agent,
    );
    return c.json(thread, 201);
  });
  app.get("/api/threads/:id", (c) => {
    const { owner: _owner, ...thread } = store.thread(
      c.var.session.owner,
      c.req.param("id"),
    );
    return c.json(thread);
  });
  app.delete("/api/threads/:id", (c) => {
    store.deleteThread(c.var.session.owner, c.req.param("id"));
    return c.json({ deleted: true });
  });
  app.post("/api/threads/:id/messages", async (c) => {
    const body = input(
      z
        .object({
          request_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
          text: z.string().trim().min(1).max(2000),
          model: z.string().min(1).max(180).optional(),
        })
        .strict(),
      c.var.body,
    );
    const owner = c.var.session.owner,
      threadId = c.req.param("id");
    store.thread(owner, threadId);
    const prior = store.previousRun(owner, body.request_id);
    if (prior) {
      // Saved receipts remain readable even if the provider/catalogue is down or a model was removed.
      const duplicate = store.beginRun(
        owner,
        threadId,
        body.request_id,
        body.text,
        body.model ?? prior.model,
      );
      return c.json(
        {
          id: duplicate.id,
          state: duplicate.state,
          reply: duplicate.reply,
          model: duplicate.model,
          evidence: store.evidence(owner, duplicate.id),
        },
        duplicate.state === "running" ? 202 : 200,
      );
    }
    const catalog = await getModels();
    const choice = catalog.models.find(
      (candidate) => candidate.id === (body.model ?? catalog.defaultModel),
    );
    if (!choice)
      throw new LocalError(
        "Choose an available model allowed by this server's keys and cost policy.",
        400,
      );
    const run = store.beginRun(
      owner,
      threadId,
      body.request_id,
      body.text,
      choice.id,
    );
    if (!run.fresh)
      return c.json(
        { id: run.id, state: run.state, reply: run.reply, model: run.model },
        run.state === "running" ? 202 : 200,
      );
    try {
      const thread = store.thread(owner, threadId);
      // A bounded context window, not a fabricated summary of older history.
      let remaining = 24_000;
      const recent: StoredMessage[] = [];
      for (const message of thread.messages.toReversed()) {
        if (message.content.length > remaining) break;
        recent.unshift(message);
        remaining -= message.content.length;
      }
      const memories: string[] = [];
      let memoryBudget = 8000;
      for (const memory of store.memories(owner)) {
        if (memory.content.length > memoryBudget) break;
        memories.push(memory.content);
        memoryBudget -= memory.content.length;
      }
      const result = await answer({
        agent: thread.agent,
        messages: recent,
        memories,
        runId: run.id,
        threadId,
        model: choice,
      });
      const reply = typeof result === "string" ? result : result.text;
      const evidence = typeof result === "string" ? undefined : result.evidence;
      store.completeRun(owner, run.id, reply, evidence);
      return c.json({
        id: run.id,
        state: "completed",
        reply,
        model: run.model,
        evidence: evidence ?? null,
      });
    } catch (error) {
      store.failRun(owner, run.id);
      throw error instanceof LocalError
        ? error
        : new LocalError(
            "The model request failed. Your message is saved; no action was executed.",
            502,
          );
    }
  });
  app.get("/api/memories", (c) => c.json(store.memories(c.var.session.owner)));
  app.post("/api/memories", (c) => {
    const body = input(
      z
        .object({
          content: z.string().trim().min(1).max(2000),
          reviewed: z.literal(true),
        })
        .strict(),
      c.var.body,
    );
    return c.json(
      store.saveMemory(c.var.session.owner, body.content, body.reviewed),
      201,
    );
  });
  app.delete("/api/memories/:id", (c) => {
    store.deleteMemory(c.var.session.owner, c.req.param("id"));
    return c.json({ deleted: true });
  });
  return app;
}
