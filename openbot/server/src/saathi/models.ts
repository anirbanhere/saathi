import { z } from "zod";
import { decryptSecret, encryptSecret } from "../credentials";
import type { RuntimeModel } from "../copilot";

export const modelProvider = z.enum(["openai", "anthropic", "meta"]);
export type ModelProvider = z.infer<typeof modelProvider>;
export const modelName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const keyInput = z.strictObject({
  provider: modelProvider,
  model: modelName,
  apiKey: z.string().trim().min(1).max(4096).regex(/^\S+$/),
});
export type ModelStatus = {
  provider: ModelProvider;
  model: string;
  selected: boolean;
};
export type ModelKeyStore = {
  save(
    owner: string,
    provider: ModelProvider,
    value: { encryptedKey: string; model: string },
  ): Promise<void>;
  select(
    owner: string,
    provider: ModelProvider,
    model: string,
  ): Promise<boolean>;
  read(
    owner: string,
    provider?: ModelProvider,
  ): Promise<{
    provider: ModelProvider;
    model: string;
    encryptedKey: string;
  } | null>;
  list(owner: string): Promise<ModelStatus[]>;
  revoke(owner: string, provider: ModelProvider): Promise<void>;
};
export type OwnerModel = {
  credentialProvider: ModelProvider;
  model: RuntimeModel;
  apiKey: string;
};
export class SaathiConfigurationError extends Error {}

export function createSaathiModels(
  store: ModelKeyStore,
  encryptionKey: string,
  runtimeOwner: (owner: string) => string = (owner) => owner,
) {
  return {
    async save(owner: string, input: unknown) {
      const value = keyInput.parse(input);
      await store.save(owner, value.provider, {
        model: value.model,
        encryptedKey: await encryptSecret(encryptionKey, value.apiKey),
      });
    },
    async select(owner: string, provider: ModelProvider, model: string) {
      if (
        !(await store.select(
          owner,
          modelProvider.parse(provider),
          modelName.parse(model),
        ))
      ) {
        throw new SaathiConfigurationError(
          "Add your own API key for this provider in Settings > Saathi.",
        );
      }
    },
    async resolve(owner: string): Promise<OwnerModel> {
      const value = await store.read(runtimeOwner(owner));
      if (!value)
        throw new SaathiConfigurationError(
          "Add your own API key and select a model in Settings > Saathi.",
        );
      return {
        credentialProvider: value.provider,
        model: {
          provider: value.provider === "meta" ? "openai" : value.provider,
          defaultModel: value.model,
        },
        apiKey: await decryptSecret(encryptionKey, value.encryptedKey),
      };
    },
    async isActive(owner: string, selection: OwnerModel) {
      const value = await store.read(
        runtimeOwner(owner),
        selection.credentialProvider,
      );
      return Boolean(
        value &&
          (await decryptSecret(encryptionKey, value.encryptedKey)) ===
            selection.apiKey,
      );
    },
    status: (owner: string) => store.list(owner),
    revoke: (owner: string, provider: ModelProvider) =>
      store.revoke(owner, modelProvider.parse(provider)),
  };
}
export type SaathiModels = ReturnType<typeof createSaathiModels>;
