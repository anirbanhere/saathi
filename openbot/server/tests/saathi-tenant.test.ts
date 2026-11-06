import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { configurationChecks } from "../../../scripts/saathi-preflight";
import { loadTenantPackage } from "../src/tenant-package";

const tenantDirectory = resolve(import.meta.dir, "../../examples/saathi");
const ready = {
  TENANT_PACKAGE_DIR: "../examples/saathi",
  OPENBOT_HOST: "127.0.0.1",
  OPENBOT_SINGLE_USER: "true",
  KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  BOT_PROVIDER: "openai",
  BOT_MODEL: "openrouter/free",
  OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
  OPENAI_API_KEY: "synthetic-model-key",
  INTELLIGENCE_API_KEY: "synthetic-intelligence-key",
  INTELLIGENCE_API_URL: "https://api.intelligence.copilotkit.ai",
  INTELLIGENCE_GATEWAY_WS_URL: "wss://realtime.intelligence.copilotkit.ai",
  COPILOTKIT_TELEMETRY_DISABLED: "true",
};

describe("Saathi tenant", () => {
  test("loads through the real platform loader with three distinct domains", async () => {
    const tenant = await loadTenantPackage(tenantDirectory);
    expect(tenant.productName).toBe("Saathi");
    expect(tenant.tenantId).toBe("saathi");
    expect(tenant.agents.map((agent) => agent.id).sort()).toEqual([
      "inventory",
      "kitchen",
      "saathi",
    ]);
    expect(tenant.channels.map((channel) => channel.id).sort()).toEqual([
      "inventory",
      "kitchen",
      "saathi",
    ]);
    expect(tenant.knowledgeSources).toEqual([]);
    // Instructions declare no connector grants and cannot create missing integrations.
    expect(tenant.skills.every((skill) => skill.tools.length === 0)).toBe(true);
    expect(tenant.model.provider).toBe("openai");
    expect(tenant.model.defaultModel).toBe(
      process.env.BOT_MODEL || "openrouter/free",
    );
  });

  test("a configured free-model profile passes without contacting a provider", () => {
    expect(configurationChecks(ready).every((check) => check.ready)).toBe(true);
  });

  test.each([
    ["OPENAI_API_KEY", ""],
    ["INTELLIGENCE_API_KEY", ""],
    ["OPENAI_BASE_URL", "https://api.openai.com/v1"],
    ["BOT_MODEL", "paid/model"],
    ["BOT_PROVIDER", "anthropic"],
    ["TENANT_PACKAGE_DIR", "../examples/openduet"],
    ["OPENBOT_HOST", "0.0.0.0"],
    ["KEY_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="],
  ])("rejects an incomplete or mismatched %s setting", (key, value) => {
    expect(
      configurationChecks({ ...ready, [key]: value }).some(
        (check) => !check.ready,
      ),
    ).toBe(true);
  });
});
