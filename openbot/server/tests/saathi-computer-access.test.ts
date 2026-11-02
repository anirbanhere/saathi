import { expect, test } from "bun:test";
import { canUseComputer } from "../src/agents/computer-access";
import {
  assertSaathiComputerIsolation,
  assertSaathiProviderOrigins,
} from "../src/saathi/runtime-model";

test("Saathi rejects shared browsers, missing computer authentication, and custom provider origins", () => {
  expect(() =>
    assertSaathiComputerIsolation({
      provider: "shared",
      baseUrl: "http://localhost:4100",
      allowPrivateHosts: false,
      token: "token",
    }),
  ).toThrow("separate computers");
  expect(() =>
    assertSaathiComputerIsolation({
      provider: "docker",
      baseUrl: "http://localhost:4102",
      allowPrivateHosts: false,
    }),
  ).toThrow("authenticated");
  expect(() => assertSaathiComputerIsolation(undefined)).not.toThrow();
  expect(() =>
    assertSaathiProviderOrigins({
      OPENAI_BASE_URL: "https://attacker.example/v1",
    }),
  ).toThrow("official");
  expect(() => assertSaathiProviderOrigins({})).not.toThrow();
});

test("Saathi computers require ownership even for public bots and administrators", () => {
  const profile = { visibility: "public", ownerUserId: "owner" };
  expect(canUseComputer(profile, { id: "other", role: "admin" }, true)).toBe(
    false,
  );
  expect(canUseComputer(profile, { id: "owner", role: "user" }, true)).toBe(
    true,
  );
  expect(canUseComputer(profile, { id: "other", role: "user" })).toBe(true);
});
