import { resolve } from "node:path";
import { loadTenantPackage } from "../openbot/server/src/tenant-package";

type Environment = Readonly<Record<string, string | undefined>>;

/** Local configuration checks only: no inference, account connection, or key values in output. */
export function configurationChecks(env: Environment) {
  const model = env.BOT_MODEL?.trim() ?? "";
  const vaultKey = env.KEY_ENCRYPTION_KEY?.trim() ?? "";
  return [
    {
      name: "Saathi tenant",
      ready: env.TENANT_PACKAGE_DIR === "../examples/saathi",
    },
    {
      name: "Loopback-only local profile",
      ready:
        env.OPENBOT_HOST === "127.0.0.1" && env.OPENBOT_SINGLE_USER === "true",
    },
    {
      name: "Non-placeholder 32-byte vault key",
      ready:
        /^[A-Za-z0-9+/]{43}=$/.test(vaultKey) &&
        Buffer.from(vaultKey, "base64").length === 32 &&
        Buffer.from(vaultKey, "base64").some((byte) => byte !== 0),
    },
    {
      name: "OpenAI-compatible protocol",
      ready: env.BOT_PROVIDER === "openai",
    },
    {
      name: "OpenRouter endpoint",
      ready: env.OPENAI_BASE_URL === "https://openrouter.ai/api/v1",
    },
    {
      name: "Explicit free model",
      ready: model === "openrouter/free" || model.endsWith(":free"),
    },
    { name: "Model key present", ready: !!env.OPENAI_API_KEY?.trim() },
    {
      name: "Intelligence key present",
      ready: !!env.INTELLIGENCE_API_KEY?.trim(),
    },
    {
      name: "Intelligence HTTPS endpoint",
      ready:
        env.INTELLIGENCE_API_URL === "https://api.intelligence.copilotkit.ai",
    },
    {
      name: "Intelligence WSS endpoint",
      ready:
        env.INTELLIGENCE_GATEWAY_WS_URL ===
        "wss://realtime.intelligence.copilotkit.ai",
    },
    {
      name: "Optional telemetry disabled",
      ready: env.COPILOTKIT_TELEMETRY_DISABLED === "true",
    },
  ];
}

if (import.meta.main) {
  const tenant = await loadTenantPackage(
    resolve(import.meta.dir, "../openbot/examples/saathi"),
  );
  console.log(
    `Tenant valid: ${tenant.productName}, ${tenant.agents.length} agents, ${tenant.channels.length} workstreams.`,
  );
  const checks = configurationChecks(process.env);
  for (const check of checks)
    console.log(`${check.ready ? "OK" : "NEEDS SETUP"}: ${check.name}`);
  console.log(
    "Configuration only. Provider capacity, account access, Docker and speech quality are not verified.",
  );
  process.exitCode = checks.every((check) => check.ready) ? 0 : 1;
}
