import { resolve } from "node:path";
import { maxMediaBytes } from "./media-contract";
import { configureRoles } from "./roles";
import { LocalError } from "./store";
import { assertFixtureSttRole } from "./stt-admission";

export function selfHostedConfig(
  env: Readonly<Record<string, string | undefined>>,
) {
  if (env.INTELLIGENCE_API_KEY?.trim() || env.CPK_INTELLIGENCE_API_KEY?.trim())
    throw new LocalError(
      "Remove cloud thread/memory credentials from the self-hosted profile.",
    );
  const model = env.BOT_MODEL?.trim() || "openrouter/free";
  const flag = (name: string) => {
    const value = env[name]?.trim() || "false";
    if (value !== "true" && value !== "false")
      throw new LocalError(`${name} must be true or false.`);
    return value === "true";
  };
  const allowPaid = flag("SAATHI_ALLOW_PAID_MODELS");
  const metaEnabled = flag("SAATHI_ENABLE_META");
  const metaWebSearch = flag("SAATHI_META_WEB_SEARCH");
  const localMediaControls = flag("SAATHI_LOCAL_MEDIA_CONTROLS");
  const localMediaUploads = flag("SAATHI_LOCAL_MEDIA_UPLOADS");
  const localFixtureSpeech = flag("SAATHI_LOCAL_FIXTURE_SPEECH");
  const price = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < 0 || value > 100)
      throw new LocalError(
        `${name} must be a token rate between 0 and 100 USD per million.`,
      );
    return value;
  };
  const maxInputPrice = price("SAATHI_MAX_INPUT_PRICE", 0.25);
  const maxOutputPrice = price("SAATHI_MAX_OUTPUT_PRICE", 1);
  if (
    !/^[A-Za-z0-9_./:-]{1,150}$/.test(model) ||
    (!allowPaid && model !== "openrouter/free" && !model.endsWith(":free"))
  )
    throw new LocalError(
      "Choose a free OpenRouter model; no paid fallback is enabled.",
    );
  const metaApiKey =
    env.META_API_KEY?.trim() || env.MODEL_API_KEY?.trim() || null;
  if (metaEnabled && !metaApiKey)
    throw new LocalError(
      "Configure META_API_KEY before enabling Meta inference.",
    );
  const metaModels = [
    ...new Set(
      (env.SAATHI_META_MODELS || "muse-spark-1.3")
        .split(",")
        .map((value) => value.trim()),
    ),
  ];
  if (
    !metaModels.length ||
    metaModels.some(
      (value) =>
        ![
          "muse-spark-1.3",
          "muse-spark-1.2",
          "muse-spark-1.1",
          "muse-wonder-1.0",
        ].includes(value),
    )
  )
    throw new LocalError(
      "Choose supported Meta Standard-mode text models. Contributor mode is not enabled by this profile.",
    );
  if (
    env.OPENAI_BASE_URL &&
    env.OPENAI_BASE_URL !== "https://openrouter.ai/api/v1"
  )
    throw new LocalError(
      "This profile uses the OpenRouter compatible endpoint.",
    );
  const port = Number(env.SAATHI_PORT || 8790);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new LocalError("Choose a local port between1024 and65535.");
  if (env.SAATHI_HOST && env.SAATHI_HOST !== "127.0.0.1")
    throw new LocalError("The starter service is loopback-only.");
  let publicOrigin: string | null = null;
  if (env.SAATHI_PUBLIC_ORIGIN?.trim()) {
    try {
      const url = new URL(env.SAATHI_PUBLIC_ORIGIN.trim());
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("origin");
      publicOrigin = url.origin;
    } catch {
      throw new LocalError(
        "Configure one canonical HTTPS public origin without credentials, path or query.",
      );
    }
  }
  if (publicOrigin && localMediaControls)
    throw new LocalError("Public mode cannot enable local media controls.");
  if (publicOrigin && localMediaUploads)
    throw new LocalError("Public mode cannot enable local media uploads.");
  if (publicOrigin && localFixtureSpeech)
    throw new LocalError("Public mode cannot enable local fixture speech.");
  const count = (name: string, fallback: number, maximum: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum)
      throw new LocalError(`${name} is outside its bounded demo allowance.`);
    return value;
  };
  const dailyLimits = publicOrigin
    ? {
        global: count("SAATHI_DAILY_CALLS", 20, 100),
        owner: count("SAATHI_WORKSPACE_DAILY_CALLS", 5, 20),
      }
    : undefined;
  if (dailyLimits && dailyLimits.owner > dailyLimits.global)
    throw new LocalError(
      "Workspace allowance cannot exceed the server allowance.",
    );
  const roles = configureRoles(env, {
    model,
    allowPaid,
    metaEnabled,
    metaModels,
  });
  if (localFixtureSpeech) assertFixtureSttRole(roles.stt);
  return {
    roles,
    localFixtureSpeech,
    host: "127.0.0.1" as const,
    port,
    path: resolve(
      env.SAATHI_DATABASE_PATH ||
        resolve(import.meta.dir, "../../../../.saathi/state.sqlite"),
    ),
    model,
    publicOrigin,
    localMediaControls,
    localMediaUploads,
    maxRequestBodySize: localMediaUploads ? maxMediaBytes : 60_000,
    dailyLimits,
    tenantPath: resolve(
      env.SAATHI_TENANT_PATH ||
        resolve(import.meta.dir, "../../../examples/saathi"),
    ),
    webPath: resolve(
      env.SAATHI_WEB_ROOT || resolve(import.meta.dir, "../../../../saathi-web"),
    ),
    allowPaid,
    maxInputPrice,
    maxOutputPrice,
    metaEnabled,
    metaWebSearch,
    metaModels,
    metaApiKey,
    apiKey:
      env.OPENROUTER_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || null,
  };
}
