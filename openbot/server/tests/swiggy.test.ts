import { afterEach, expect, test } from "bun:test";
import {
  catalogueEntry,
  classifyTool,
  resolveServerUrl,
} from "../src/plugins/catalogue";
import { tokenRequest, revocationRequest } from "../src/plugins/oauth-http";
import { safetyRequirement } from "../src/approvals/policy";
import { redeemAuthorizationCode } from "../src/plugins/oauth";
import {
  exchangeRefreshTokenOverHttp,
  revokeRefreshTokenOverHttp,
} from "../src/plugins/plugin-store/model";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("Swiggy pins Food and treats every unreviewed action as a write", () => {
  const entry = catalogueEntry("swiggy-food");
  expect(entry).not.toBeNull();
  expect(resolveServerUrl("swiggy-food", "https://evil.test").url).toBe(
    "https://mcp.swiggy.com/food",
  );
  expect(classifyTool(entry, "search_restaurants", true)).toBe("read");
  for (const name of [
    "update_food_cart",
    "place_food_order",
    "confirm_order",
    "delete_address",
    "new_future_tool",
  ]) {
    expect(classifyTool(entry, name, true, "read")).toBe("write");
  }
  expect(classifyTool(entry, "search_restaurants", false)).toBe("write");
});

test("Swiggy uses JSON token exchange and bearer session logout; other vendors stay form encoded", () => {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: "test-token",
  });
  const json = tokenRequest("https://mcp.swiggy.com/auth/token", params);
  expect(json.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(String(json.body))).toEqual(Object.fromEntries(params));
  const form = tokenRequest("https://mcp.notion.com/token", params);
  expect(form.body).toBe(params);
  const logout = revocationRequest(
    "https://mcp.swiggy.com/auth/logout",
    params,
    "test-token",
  );
  expect(logout.headers.authorization).toBe("Bearer test-token");
  expect(String(logout.body)).not.toContain("test-token");
});

test("Food placement and paid-order confirmation require checkout handover", () => {
  for (const name of ["place_food_order", "confirm_order"]) {
    expect(
      safetyRequirement({
        actorId: "owner",
        botId: "bot",
        toolRef: `swiggy-food/${name}`,
        effect: "write",
        scope: "swiggy-food",
        args: { addressId: "address" },
      })?.id,
    ).toBe("payments");
  }
});

test("Swiggy code exchange and rotating refresh reach only the pinned JSON endpoint", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe("https://mcp.swiggy.com/auth/token");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    calls.push(init);
    return Response.json({
      access_token: "test-access",
      refresh_token: "test-rotated",
      expires_in: 3600,
    });
  }) as typeof fetch;
  const client = { clientId: "test-client", clientSecret: "" };
  const grant = await redeemAuthorizationCode({
    tokenUrl: "https://mcp.swiggy.com/auth/token",
    ...client,
    code: "test-code",
    redirectUri: "http://localhost:3010/api/plugins/oauth/callback",
    verifier: "test-verifier",
  });
  expect(grant?.refreshToken).toBe("test-rotated");
  expect(JSON.parse(String(calls[0]?.body)).code_verifier).toBe(
    "test-verifier",
  );
  const renewed = await exchangeRefreshTokenOverHttp({
    tokenUrl: "https://mcp.swiggy.com/auth/token",
    client,
    refreshToken: "test-old",
  });
  expect(renewed.refreshToken).toBe("test-rotated");
  expect(JSON.parse(String(calls[1]?.body))).toEqual({
    grant_type: "refresh_token",
    refresh_token: "test-old",
    client_id: "test-client",
  });
});

test("Swiggy logout does not follow redirects or leak its token in the body", async () => {
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    expect(String(url)).toBe("https://mcp.swiggy.com/auth/logout");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer test-session",
    );
    expect(init.body).toBe("{}");
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.test" },
    });
  }) as typeof fetch;
  expect(
    await revokeRefreshTokenOverHttp({
      revokeUrl: "https://mcp.swiggy.com/auth/logout",
      client: null,
      refreshToken: "test-session",
    }),
  ).toBe("refused");
});
