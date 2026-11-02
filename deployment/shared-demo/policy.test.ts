import { expect, test } from "bun:test";
import { demoPathAllowed, visitorPathAllowed, isModelRun } from "./policy";

test("visitor Food routes open only the personal connector, never admin or model secrets", () => {
  for (const [method, path] of [
    ["GET", "/api/saathi/food"],
    ["POST", "/api/saathi/food/enable"],
    ["POST", "/api/plugins/servers/swiggy-food/connect?returnTo=food"],
    ["GET", "/api/plugins/oauth/callback?code=test"],
    ["DELETE", "/api/plugins/servers/swiggy-food/connection"],
  ]) {
    expect(visitorPathAllowed(method!, path!)).toBe(true);
    expect(demoPathAllowed(method!, path!)).toBe(false);
  }
  for (const path of [
    "/api/saathi/model-key",
    "/api/plugins/grants",
    "/api/plugins/servers",
    "/api/plugins/servers/notion/connect",
    "/api/admin/credentials",
    "/api/saathi/../model-key",
    "/api/saathi/%66ood/enable",
  ])
    expect(visitorPathAllowed("POST", path)).toBe(false);
});
test("shared demo exposes conversations, streaming, and generated pages", () => {
  expect(demoPathAllowed("POST", "/api/computers/demo/navigate")).toBe(true);
  expect(demoPathAllowed("POST", "/api/computers/demo/snapshot")).toBe(true);
  expect(demoPathAllowed("GET", "/api/voice/sessions?channelId=demo")).toBe(
    true,
  );
  expect(demoPathAllowed("GET", "/api/settings/preferences")).toBe(true);
  expect(demoPathAllowed("GET", "/api/admin/enterprise/me")).toBe(false);
  expect(demoPathAllowed("PUT", "/api/components/catalogue")).toBe(false);
  expect(demoPathAllowed("PATCH", "/api/settings/preferences")).toBe(false);
  expect(demoPathAllowed("POST", "/api/plugins/for/demo")).toBe(false);
  expect(demoPathAllowed("POST", "/api/channels/first-day")).toBe(true);
  expect(demoPathAllowed("POST", "/api/channels/morning-brief")).toBe(true);
  expect(
    demoPathAllowed(
      "GET",
      "/api/copilotkit/threads/01234567-0123-0123-0123-0123456789ab/messages?agentId=bot",
    ),
  ).toBe(true);
  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/assets/app.js"],
    ["GET", "/api/me"],
    ["GET", "/api/channels/events"],
    ["GET", "/api/computers/bot/stream"],
    ["POST", "/api/copilotkit/agent/bot/run"],
    ["POST", "/api/copilotkit/agent/bot/connect"],
    ["POST", "/api/channels"],
    ["PUT", "/api/channels/id/read"],
  ])
    expect(demoPathAllowed(method!, path!)).toBe(true);
});
test("demo refuses administration, credentials, approvals, shell and path escapes", () => {
  for (const [method, path] of [
    ["POST", "/api/saathi/model-key"],
    ["GET", "/api/saathi/status"],
    ["GET", "/api/admin/credentials"],
    ["POST", "/api/approvals/id/decision"],
    ["POST", "/api/computers/bot/exec"],
    ["POST", "/api/agents"],
    ["GET", "/settings/saathi"],
    ["GET", "//evil.test/"],
    ["GET", "/%61pi/admin/credentials"],
    ["GET", "/api/channels/%2e%2e/admin"],
    ["GET", "/api/channels/%252e%252e/admin"],
    ["GET", "/api/channels%2f..%2fadmin"],
    ["GET", "/internal/routines/run"],
  ])
    expect(demoPathAllowed(method!, path!)).toBe(false);
  expect(isModelRun("POST", "/api/copilotkit/agent/bot/run")).toBe(true);
  expect(isModelRun("POST", "/api/copilotkit/agent/bot/connect")).toBe(false);
});
