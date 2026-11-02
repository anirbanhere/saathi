import { timingSafeEqual } from "node:crypto";
import { demoPathAllowed, visitorPathAllowed, isModelRun } from "./policy";

const token = process.env.SAATHI_DEMO_GATEWAY_TOKEN ?? "";
const origin = process.env.OPENBOT_PUBLIC_URL ?? "";
const backend = new URL(
  process.env.DEMO_BACKEND_URL ?? "http://public-web:3001",
);
if (
  token.length < 43 ||
  !origin.startsWith("https://") ||
  backend.hostname !== "public-web"
)
  throw new Error("Missing dedicated demo bridge configuration.");
const MAX_BODY = 256 * 1024;
const MAX_RUN_MS = 5 * 60_000;
let runs = 0;
let windowStart = Date.now();
let inFlight = 0;
type State = {
  started: boolean;
  abort: AbortController;
  inward?: WebSocket;
  counted?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
function release(data: State) {
  if (data.counted) {
    inFlight--;
    data.counted = false;
  }
  clearTimeout(data.timer);
}
function error(
  ws: Bun.ServerWebSocket<State>,
  status: number,
  message: string,
) {
  ws.send(
    JSON.stringify({
      type: "head",
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  ws.send(
    JSON.stringify({
      type: "body",
      data: Buffer.from(JSON.stringify({ error: message })).toString("base64"),
    }),
  );
  ws.send(JSON.stringify({ type: "end" }));
  // The receiver closes only after processing every frame, including this end marker.
}
Bun.serve<State>({
  port: 8800,
  hostname: "0.0.0.0",
  maxRequestBodySize: MAX_BODY,
  fetch(request, server) {
    const received = request.headers.get("x-saathi-demo-token") ?? "";
    const receivedBytes = Buffer.from(received);
    const expectedBytes = Buffer.from(token);
    if (
      receivedBytes.length !== expectedBytes.length ||
      !timingSafeEqual(receivedBytes, expectedBytes)
    )
      return new Response("Unauthorized", { status: 401 });

    if (
      new URL(request.url).pathname !== "/bridge" ||
      request.headers.get("upgrade") !== "websocket"
    )
      return new Response("Not found", { status: 404 });
    if (
      server.upgrade(request, {
        data: { started: false, abort: new AbortController() },
      })
    )
      return;
    return new Response("Upgrade required", { status: 426 });
  },
  websocket: {
    maxPayloadLength: MAX_BODY * 2,
    idleTimeout: 180,
    backpressureLimit: 8 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    async message(ws, payload) {
      const state = ws.data;
      if (state.started) {
        if (state.inward?.readyState === WebSocket.OPEN)
          state.inward.send(payload);
        return;
      }
      state.started = true;
      try {
        if (typeof payload !== "string" || payload.length > MAX_BODY * 1.5)
          return error(ws, 413, "Demo request is too large.");
        const input = JSON.parse(payload);
        const visitor =
          typeof input.visitorId === "string" &&
          /^[A-Za-z0-9:_-]{1,200}$/.test(input.visitorId)
            ? input.visitorId
            : null;
        if (input.visitorId !== undefined && !visitor)
          return error(ws, 401, "Invalid visitor identity.");
        if (
          typeof input.path !== "string" ||
          typeof input.method !== "string" ||
          !(visitor ? visitorPathAllowed : demoPathAllowed)(
            input.method,
            input.path,
          )
        )
          return error(
            ws,
            403,
            "This shared demo supports chat, research and generated pages. Settings stay private.",
          );
        const address = new URL(input.path, backend);
        if (address.origin !== backend.origin)
          return error(ws, 403, "Invalid demo path.");
        const headers = new Headers({
          "x-saathi-demo-token": token,
          origin,
          "accept-encoding": "identity",
        });
        if (visitor) headers.set("x-saathi-site-user-id", visitor);
        for (const key of ["content-type", "accept"])
          if (typeof input.headers?.[key] === "string")
            headers.set(key, input.headers[key]);
        if (input.mode === "socket") {
          if (
            input.method !== "GET" ||
            !(
              address.pathname === "/api/channels/events" ||
              /^\/api\/computers\/[^/]+\/stream$/.test(address.pathname)
            )
          )
            return error(ws, 403, "Socket unavailable.");
          address.protocol = "ws:";
          const inward = new WebSocket(address, {
            headers: Object.fromEntries(headers),
          });
          state.inward = inward;
          inward.binaryType = "arraybuffer";
          inward.onopen = () => ws.send(JSON.stringify({ type: "ready" }));
          inward.onmessage = (event) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(event.data);
          };
          inward.onerror = () => ws.close(1011, "Demo connection failed");
          inward.onclose = () => ws.close(1000);
          return;
        }
        const body = input.body ? Buffer.from(input.body, "base64") : undefined;
        if (body && body.length > MAX_BODY)
          return error(ws, 413, "Demo request is too large.");
        if (isModelRun(input.method, input.path)) {
          if (Date.now() - windowStart > 3_600_000) {
            runs = 0;
            windowStart = Date.now();
          }
          if (runs >= 60 || inFlight >= 2)
            return error(
              ws,
              429,
              "The shared demo is busy. Please try again shortly.",
            );
          runs++;
          inFlight++;
          state.counted = true;
          state.timer = setTimeout(() => {
            state.abort.abort();
            release(state);
            ws.close(1000, "Demo turn time limit");
          }, MAX_RUN_MS);
        }
        const response = await fetch(address, {
          method: input.method,
          headers,
          body: ["GET", "HEAD"].includes(input.method) ? undefined : body,
          redirect: "manual",
          signal: state.abort.signal,
        });
        const responseHeaders: Record<string, string> = {};
        for (const key of [
          "content-type",
          "cache-control",
          "content-disposition",
          "etag",
          "last-modified",
        ]) {
          const value = response.headers.get(key);
          if (value) responseHeaders[key] = value;
        }
        const location = response.headers.get("location");
        // OAuth may return only to this Site's food page, never an arbitrary upstream location.
        if (
          visitor &&
          location &&
          (location === `${origin}/food` ||
            location === `${origin}/food?connected=failed`)
        )
          responseHeaders.location = location;
        // No Set-Cookie, service credential, redirect target, or upstream identity is forwarded.
        ws.send(
          JSON.stringify({
            type: "head",
            status: response.status,
            headers: responseHeaders,
          }),
        );
        if (response.body) {
          for await (const chunk of response.body) {
            if (state.abort.signal.aborted) break;
            // Keep binary frames small and await Bun's send queue before reading more upstream.
            for (let i = 0; i < chunk.length; i += 64 * 1024) {
              while (
                ws.getBufferedAmount() > 512 * 1024 &&
                !state.abort.signal.aborted
              )
                await Bun.sleep(10);
              if (!state.abort.signal.aborted)
                ws.send(
                  JSON.stringify({
                    type: "body",
                    data: Buffer.from(
                      chunk.subarray(i, i + 64 * 1024),
                    ).toString("base64"),
                  }),
                );
            }
          }
        }
        if (!state.abort.signal.aborted) {
          ws.send(JSON.stringify({ type: "end" }));
          // Let the receiver finish consuming queued frames before closing the socket.
        }
      } catch {
        if (!state.abort.signal.aborted)
          error(
            ws,
            502,
            "The local demo server is unavailable. Please try again shortly.",
          );
      } finally {
        if (!state.inward) release(state);
      }
    },
    close(ws) {
      ws.data.abort.abort();
      ws.data.inward?.close();
      release(ws.data);
    },
  },
});
console.log("Protected shared-demo bridge listening on port 8800");
