import { expect, test } from "bun:test";
import {
  createDemoGatewayAuth,
  demoGatewayConfig,
  siteVisitorId,
} from "../src/auth/demo-gateway";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

const userId = "saathi-demo-0123456789abcdef";
const token = "a".repeat(64);
test("Sites visitors require the bridge secret and get distinct non-admin identities", async () => {
  let provisioned = 0;
  const auth = createDemoGatewayAuth(
    { token, userId },
    async (id) => ({ id, email: "shared@example.test" }),
    async (id) => {
      provisioned++;
      return { id, email: `${id}@sites.saathi.invalid` };
    },
  );
  const headers = new Headers({
    "x-saathi-site-user-id": "visitor-a",
    "x-user-role": "admin",
  });
  expect(await auth.api.getSession({ headers })).toBeNull();
  expect(provisioned).toBe(0);
  headers.set("x-saathi-demo-token", token);
  const a = await auth.api.getSession({ headers });
  headers.set("x-saathi-site-user-id", "visitor-b");
  const b = await auth.api.getSession({ headers });
  expect(a?.user.id).toBe(siteVisitorId("visitor-a")!);
  expect(a?.user.id).not.toBe(b?.user.id);
  expect(a?.user.role).toBe("user");
  headers.set("x-saathi-site-user-id", "../../dev-local-user");
  expect(await auth.api.getSession({ headers })).toBeNull();
});
test("public demo requires an explicit secret and isolated user, never the local admin", () => {
  expect(demoGatewayConfig({})).toBeUndefined();
  expect(() => demoGatewayConfig({ SAATHI_PUBLIC_DEMO: "true" })).toThrow();
  expect(() =>
    demoGatewayConfig({
      SAATHI_PUBLIC_DEMO: "true",
      SAATHI_ENABLED: "true",
      SAATHI_DEMO_GATEWAY_TOKEN: token,
      SAATHI_DEMO_USER_ID: "dev-local-user",
    }),
  ).toThrow();
});
test("gateway authentication refuses anonymous or forged identities and returns only a regular user", async () => {
  const auth = createDemoGatewayAuth({ token, userId }, async (id) => ({
    id,
    email: "demo@example.test",
  }));
  expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
  expect(
    await auth.api.getSession({
      headers: new Headers({ "x-saathi-demo-token": "é".repeat(64) }),
    }),
  ).toBeNull();
  expect(
    await auth.api.getSession({
      headers: new Headers({
        "x-saathi-demo-token": "wrong",
        "x-user-role": "admin",
      }),
    }),
  ).toBeNull();
  const session = await auth.api.getSession({
    headers: new Headers({
      "x-saathi-demo-token": token,
      "x-user-id": "dev-local-user",
    }),
  });
  expect(session?.user.id).toBe(userId);
  expect(session?.user.role).toBe("user");
  const removed = createDemoGatewayAuth({ token, userId }, async () => null);
  expect(
    await removed.api.getSession({
      headers: new Headers({ "x-saathi-demo-token": token }),
    }),
  ).toBeNull();
});
test("configured demo authentication prevents the single-user administrator fallback", () => {
  const config = loadConfig(
    testEnvironment({
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      BETTER_AUTH_SECRET: undefined,
      BETTER_AUTH_URL: undefined,
      INITIAL_ADMIN_EMAILS: undefined,
      OPENBOT_SINGLE_USER: "true",
      OPENBOT_PUBLIC_URL: "https://demo.example.test",
      SAATHI_ENABLED: "true",
      SAATHI_PUBLIC_DEMO: "true",
      SAATHI_DEMO_USER_ID: userId,
      SAATHI_DEMO_GATEWAY_TOKEN: token,
    }),
  );
  expect(config.singleUser).toBe(false);
  expect(config.demoGateway?.userId).toBe(userId);
});
