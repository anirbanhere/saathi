import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppVariables, AuthenticatedActor } from "../auth/guards";
import {
  SaathiConfigurationError,
  type SaathiModels,
  modelName,
  modelProvider,
} from "./models";
import type { ConnectionStore } from "./connection-store";
import type { CallService } from "./calls";
import { createCallRoutes } from "./call-routes";

export type SaathiRoutes = {
  models: SaathiModels;
  connections: Pick<ConnectionStore, "get" | "disconnect">;
  connect(
    actor: AuthenticatedActor,
    token: string,
  ): Promise<{ pairingCode: string }>;
  validateModel(owner: string, input: unknown): Promise<void>;
  speechConfigured: boolean;
  calls?: CallService;
  publicDemo?: boolean;
};
export function createSaathiRoutes(
  deps: SaathiRoutes,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", requireUser, bodyLimit({ maxSize: 16_384 }));
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, context) =>
    context.json(
      {
        error:
          error instanceof SaathiConfigurationError
            ? error.message
            : error instanceof z.ZodError
              ? "Check the provider, model name, and required fields."
              : "Saathi could not save this change. Please retry or check your configuration.",
      },
      error instanceof SaathiConfigurationError || error instanceof z.ZodError
        ? 400
        : 503,
    ),
  );
  if (deps.calls)
    app.route("/calls", createCallRoutes(deps.calls, deps.publicDemo ?? false));
  app.get("/status", async (context) => {
    const owner = context.var.actor.id;
    const [models, connection] = await Promise.all([
      deps.models.status(owner),
      deps.connections.get(owner),
    ]);
    return context.json({
      models,
      speechConfigured: deps.speechConfigured,
      connection: connection
        ? {
            status: connection.status,
            lastError: connection.lastError,
            channelId: connection.channelId,
            pairingExpiresAt:
              connection.status === "pairing"
                ? connection.pairingExpiresAt
                : null,
          }
        : null,
    });
  });
  app.post("/model-key", async (context) => {
    const input: unknown = await context.req.json();
    await deps.validateModel(context.var.actor.id, input);
    await deps.models.save(context.var.actor.id, input);
    return context.json({ saved: true });
  });
  app.put("/model", async (context) => {
    const input = z
      .strictObject({ provider: modelProvider, model: modelName })
      .parse(await context.req.json());
    await deps.models.select(context.var.actor.id, input.provider, input.model);
    return context.json({ saved: true });
  });
  app.delete("/model-key/:provider", async (context) => {
    await deps.models.revoke(
      context.var.actor.id,
      modelProvider.parse(context.req.param("provider")),
    );
    return context.json({ revoked: true });
  });
  app.post("/whatsapp", async (context) => {
    const input = z
      .strictObject({
        token: z.string().trim().min(1).max(4096).regex(/^\S+$/),
      })
      .parse(await context.req.json());
    return context.json(
      await deps.connect(context.var.actor, input.token),
      201,
    );
  });
  app.delete("/whatsapp", async (context) => {
    await deps.connections.disconnect(context.var.actor.id);
    return context.json({ disconnected: true });
  });
  return app;
}
