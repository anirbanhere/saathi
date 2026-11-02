import { createOpenAI } from "@ai-sdk/openai";
import type { PlanLanguageModel } from "../agents/plan-model";

// https://dev.meta.ai/docs/quickstart — never accept an arbitrary credential destination.
export const META_BASE_URL = "https://api.meta.ai/v1";

export async function verifyMetaModel(
  model: string,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<void> {
  try {
    const response = await request(
      `${META_BASE_URL}/models/${encodeURIComponent(model)}`,
      {
        headers: { authorization: `Bearer ${apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (
      response.ok &&
      ((await response.json()) as { id?: unknown }).id === model
    )
      return;
  } catch {
    // Provider errors can contain sensitive request details; expose only actionable local text.
  }
  throw new Error(
    "Meta could not verify access to this model. Check your API key and model ID.",
  );
}

export function createMetaModel(
  model: string,
  apiKey: string,
  request: typeof fetch = fetch,
): PlanLanguageModel {
  const guardedFetch: typeof fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.origin !== "https://api.meta.ai" ||
        url.pathname !== "/v1/responses"
      ) {
        throw new Error(
          "Refusing a model request outside the official Meta endpoint.",
        );
      }
      return request(input, { ...init, redirect: "error" });
    },
    { preconnect: request.preconnect },
  );
  const inner = createOpenAI({
    name: "meta",
    baseURL: META_BASE_URL,
    apiKey,
    fetch: guardedFetch,
  }).responses(model);
  const optionsFor = (
    options: Parameters<PlanLanguageModel["doGenerate"]>[0],
  ) => ({
    ...options,
    providerOptions: {
      ...options.providerOptions,
      openai: {
        ...options.providerOptions?.openai,
        forceReasoning: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      },
    },
  });
  return {
    specificationVersion: inner.specificationVersion,
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    doGenerate: (options) => inner.doGenerate(optionsFor(options)),
    doStream: (options) => inner.doStream(optionsFor(options)),
  };
}
