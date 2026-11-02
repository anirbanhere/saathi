import { Hono } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import { CallError, type CallService } from "./calls";

/** Mounted inside the authenticated, bounded Saathi router; never a provider webhook. */
export function createCallRoutes(service: CallService, publicDemo: boolean) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", async (context, next) => {
    if (publicDemo)
      return context.json(
        { error: "Phone calls are available only in the private companion." },
        403,
      );
    await next();
  });
  routes.onError((error, context) =>
    context.json(
      {
        error:
          error instanceof CallError
            ? error.message
            : error instanceof z.ZodError
              ? "Check the +91 number, purpose, disclosure, language and 30–600 second limit."
              : "Call controls are temporarily unavailable.",
      },
      error instanceof CallError || error instanceof z.ZodError ? 400 : 503,
    ),
  );
  routes.get("/", async (context) =>
    context.json({
      ...service.readiness(),
      calls: await service.list(context.var.actor.id),
    }),
  );
  routes.post("/", async (context) =>
    context.json(
      {
        call: await service.request(
          context.var.actor.id,
          await context.req.json(),
        ),
      },
      201,
    ),
  );
  routes.post("/simulate-incoming", async (context) =>
    context.json(
      {
        call: await service.incoming(
          context.var.actor.id,
          await context.req.json(),
        ),
      },
      201,
    ),
  );
  routes.post("/:id/approve", async (context) => {
    const body = z
      .strictObject({ previewHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await context.req.json());
    return context.json({
      call: await service.approve(
        context.var.actor.id,
        context.req.param("id"),
        body.previewHash,
      ),
    });
  });
  routes.post("/:id/control", async (context) => {
    const body = z
      .strictObject({ action: z.enum(["answer", "takeover", "end"]) })
      .parse(await context.req.json());
    return context.json({
      call: await service.control(
        context.var.actor.id,
        context.req.param("id"),
        body.action,
      ),
    });
  });
  return routes;
}
