import { resolveModel } from "@copilotkit/runtime/v2";
import type { PlanLanguageModel } from "../agents/plan-model";
import type { ComputerConfig } from "../config";
import { isCustomModelBase } from "../model-availability-check";
import { createModelCompleter } from "../routing/model";
import { SaathiConfigurationError, type SaathiModels } from "./models";
import { createMetaModel, META_BASE_URL } from "./meta";

export function assertSaathiComputerIsolation(
  computer: ComputerConfig | undefined,
) {
  if (
    computer &&
    (computer.provider === "shared" ||
      !computer.token ||
      (computer.provider === "docker" && !computer.supervisorToken))
  )
    throw new SaathiConfigurationError(
      "Saathi requires authenticated, separate computers per Bot. Configure the computer supervisor or leave computer access disabled.",
    );
}

export function assertSaathiProviderOrigins(
  environment: Record<string, string | undefined>,
) {
  if (
    isCustomModelBase("openai", environment.OPENAI_BASE_URL) ||
    isCustomModelBase("anthropic", environment.ANTHROPIC_BASE_URL)
  ) {
    throw new SaathiConfigurationError(
      "Saathi BYOK currently requires official OpenAI and Anthropic origins. Remove custom model base URLs before starting.",
    );
  }
}

export async function ownerRuntimeModel(models: SaathiModels, owner: string) {
  const selection = await models.resolve(owner);
  const inner =
    selection.credentialProvider === "meta"
      ? createMetaModel(selection.model.defaultModel, selection.apiKey)
      : (resolveModel(
          `${selection.model.provider}/${selection.model.defaultModel}`,
          selection.apiKey,
        ) as PlanLanguageModel);
  const assertActive = async () => {
    if (!(await models.isActive(owner, selection)))
      throw new SaathiConfigurationError(
        "Your model key was revoked or replaced. Start a new run with your current key.",
      );
  };
  const client: PlanLanguageModel = {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate(options) {
      await assertActive();
      return inner.doGenerate({
        ...options,
        maxOutputTokens: Math.min(options.maxOutputTokens ?? 4096, 4096),
      });
    },
    async doStream(options) {
      await assertActive();
      return inner.doStream({
        ...options,
        maxOutputTokens: Math.min(options.maxOutputTokens ?? 4096, 4096),
      });
    },
  };
  return { model: { ...selection.model, client }, apiKey: selection.apiKey };
}

export async function completeForOwner(
  models: SaathiModels,
  owner: string,
  prompt: string,
  signal?: AbortSignal,
) {
  const selection = await models.resolve(owner);
  return createModelCompleter({
    model: selection.model,
    resolveApiKey: async () => selection.apiKey,
    environment:
      selection.credentialProvider === "meta"
        ? { OPENAI_BASE_URL: META_BASE_URL }
        : {},
  })(prompt, signal);
}
