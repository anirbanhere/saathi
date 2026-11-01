import { createAnswer } from "./answer";
import { createSelfHostedApp } from "./app";
import { selfHostedConfig } from "./config";
import { createModelCatalog } from "./models";
import { createPlanner } from "./planner";
import { SelfHostedStore } from "./store";
import { attachSelfHostedWeb } from "./web";

// This entry needs neither optional analytics nor a cloud thread/memory client.
process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
const config = selfHostedConfig(process.env);
const answer = await createAnswer(config);
const planner = await createPlanner(config);
const store = new SelfHostedStore(config.path, { limits: config.dailyLimits });
const app = attachSelfHostedWeb(
  createSelfHostedApp({
    store,
    answer,
    model: config.roles.conversation.model,
    models: createModelCatalog(config),
    publicOrigin: config.publicOrigin,
    roles: config.roles,
    planner,
    localMediaControls: config.localMediaControls,
    localMediaUploads: config.localMediaUploads,
  }),
  config.webPath,
);
const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  maxRequestBodySize: config.maxRequestBodySize,
  idleTimeout: 120,
  fetch: app.fetch,
});
console.log(
  `Saathi self-hosted threads/memory: http://${config.host}:${config.port}`,
);
console.log(
  `Storage: SQLite on this server. Chat keys: OpenRouter ${config.apiKey ? "configured" : "missing"}; Meta ${config.metaEnabled ? "enabled, availability unverified" : "disabled"}. Controlled mock appointments available; live actions/speech/notifications unavailable.`,
);
const stop = () => {
  server.stop(true);
  store.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
