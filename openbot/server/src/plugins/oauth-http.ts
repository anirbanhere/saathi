import { CATALOGUE } from "./catalogue";

// Endpoint-specific encoding comes only from reviewed entries, never request input.
export function tokenRequest(url: string, params: URLSearchParams) {
  const json = CATALOGUE.some(
    (entry) =>
      entry.auth.kind === "user-oauth" &&
      entry.auth.tokenUrl === url &&
      entry.auth.tokenEncoding === "json",
  );
  return {
    headers: {
      "content-type": json
        ? "application/json"
        : "application/x-www-form-urlencoded",
    },
    body: json ? JSON.stringify(Object.fromEntries(params)) : params,
  };
}

export function revocationRequest(
  url: string,
  params: URLSearchParams,
  token: string,
): {
  headers: Record<string, string>;
  body: string | URLSearchParams;
} {
  const bearer = CATALOGUE.some(
    (entry) =>
      entry.auth.kind === "user-oauth" &&
      entry.auth.revokeUrl === url &&
      entry.auth.revocationMode === "bearer-session",
  );
  return bearer
    ? {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: "{}",
      }
    : {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params,
      };
}
