import { resolve } from "node:path";
import type { createSelfHostedApp } from "./app";
import { LocalError } from "./store";

export function attachSelfHostedWeb(
  app: ReturnType<typeof createSelfHostedApp>,
  web = resolve(import.meta.dir, "../../../../saathi-web"),
) {
  app.get(
    "/",
    () =>
      new Response(Bun.file(resolve(web, "index.html")), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
  );
  app.get("/assets/:name", (c) => {
    const name = c.req.param("name");
    if (
      ![
        "app.js",
        "export.js",
        "appointments.js",
        "plans.js",
        "media.js",
        "upload.js",
        "fixture.js",
        "style.css",
      ].includes(name)
    )
      throw new LocalError("Asset not found.", 404);
    return new Response(Bun.file(resolve(web, name)), {
      headers: {
        "Content-Type": name.endsWith("js")
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8",
      },
    });
  });
  app.get("/favicon.ico", () => new Response(null, { status: 204 }));
  return app;
}
