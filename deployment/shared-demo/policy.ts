/** Routes exposed by the shared demo. Everything else stays on the private companion. */
export function demoPathAllowed(method: string, target: string): boolean {
  if (
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\")
  )
    return false;
  const rawPath = target.split("?")[0];
  if (/%(?:2f|5c|25)/i.test(rawPath)) return false;
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  if (
    path.split("/").some((part) => part === "." || part === "..") ||
    path.includes("\0")
  )
    return false;
  if (!path.startsWith("/api/")) {
    return (
      (method === "GET" || method === "HEAD") &&
      (path === "/" ||
        /^\/(assets\/|channel\/|tasks(?:\/|$)|make(?:\/|$)|pages\/|favicon|icon|manifest|robots)/.test(
          path,
        ))
    );
  }
  if (method === "GET" || method === "HEAD") {
    return (
      [
        "/api/settings/preferences",
        "/api/sandboxed/published",
        "/api/voice/sessions",
      ].includes(path) ||
      /^\/api\/plugins\/for\/[^/]+(?:\/apps(?:\/[^/]+)?)?$/.test(path) ||
      /^\/api\/(?:me$|capabilities$|agents(?:\/|$)|channels(?:\/|$)|threads(?:\/|$)|copilotkit\/info$|openduet\/(?:tasks|pages|channels)(?:\/|$)|components(?:\/|$)|approvals$|bots(?:\/|$)|proactive(?:\/|$)|user-preferences$)/.test(
        path,
      ) ||
      /^\/api\/copilotkit\/threads\/[a-f0-9-]+\/messages$/.test(path) ||
      /^\/api\/computers\/[^/]+\/(?:status|screenshot|read|control|computers|page-frame\/[^/]+|stream)$/.test(
        path,
      )
    );
  }
  if (method === "POST")
    return (
      path === "/api/channels" ||
      path === "/api/channels/first-day" ||
      path === "/api/channels/morning-brief" ||
      path === "/api/threads/mint" ||
      path === "/api/route" ||
      /^\/api\/computers\/[^/]+\/(?:navigate|snapshot)$/.test(path) ||
      /^\/api\/channels\/[^/]+\/(?:activity|busy)$/.test(path) ||
      /^\/api\/copilotkit\/agent\/[^/]+\/(?:run|connect|stop)$/.test(path) ||
      /^\/api\/openduet\/(?:pages|tasks)(?:\/[^/]+(?:\/(?:run|cancel))?)?$/.test(
        path,
      )
    );
  return method === "PUT" && /^\/api\/channels\/[^/]+\/read$/.test(path);
}

export function isModelRun(method: string, path: string): boolean {
  return (
    method === "POST" &&
    (/\/agent\/[^/]+\/run(?:\?|$)/.test(path) ||
      path.startsWith("/api/openduet/tasks"))
  );
}

/** Extra routes for a Sites-authenticated visitor, still enforced by the API's owner checks. */
export function visitorPathAllowed(method: string, target: string): boolean {
  if (demoPathAllowed(method, target)) return true;
  const path = target.split("?")[0] ?? "";
  if (
    !path.startsWith("/") ||
    /[%\\\0]/.test(path) ||
    path.split("/").some((p) => p === "." || p === "..")
  )
    return false;
  if (method === "GET")
    return ["/api/saathi/food", "/api/plugins/oauth/callback"].includes(path);
  if (method === "POST")
    return (
      [
        "/api/saathi/food/start",
        "/api/saathi/food/enable",
        "/api/plugins/servers/swiggy-food/connect",
      ].includes(path) ||
      /^\/api\/approvals\/[a-f0-9-]+\/decision$/.test(path) ||
      /^\/api\/approvals\/questions\/[a-f0-9-]+\/respond$/.test(path)
    );
  return (
    method === "DELETE" &&
    path === "/api/plugins/servers/swiggy-food/connection"
  );
}
