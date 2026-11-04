import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const sample = {
  format: "saathi-text-export-v1",
  scope: "conversations_and_reviewed_preferences",
  complete_for_scope: true,
  exported_at: 1,
  excluded: [],
  threads: [],
  memories: [],
};
function browser(
  fetcher: (url: string, init: RequestInit) => Promise<Response> = async () =>
    Response.json(sample),
  clickFails = false,
) {
  const source = readFileSync(
    resolve(import.meta.dir, "../../../saathi-web/export.js"),
    "utf8",
  );
  const requests: { url: string; init: RequestInit }[] = [],
    blobs: Blob[] = [],
    revoked: string[] = [],
    timers = new Map<number, { fn: () => void; delay: number }>();
  let serial = 0,
    clicks = 0,
    removed = 0;
  const anchor = {
    href: "",
    download: "",
    hidden: false,
    click() {
      clicks++;
      if (clickFails) throw Error("synthetic-private-click");
    },
    remove() {
      removed++;
    },
  };
  const run = runInNewContext(
    source.replace("export async function", "async function") +
      "\ndownloadTextExport",
    {
      Blob,
      Uint8Array,
      TextDecoder,
      AbortController,
      fetch: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return fetcher(url, init);
      },
      URL: {
        createObjectURL(blob: Blob) {
          blobs.push(blob);
          return "blob:synthetic-download";
        },
        revokeObjectURL(url: string) {
          revoked.push(url);
        },
      },
      document: {
        createElement(tag: string) {
          expect(tag).toBe("a");
          return anchor;
        },
        body: {
          appendChild(node: unknown) {
            expect(node).toBe(anchor);
          },
        },
      },
      setTimeout(fn: () => void, delay: number) {
        const id = ++serial;
        timers.set(id, { fn, delay });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
  ) as (csrf: string) => Promise<void>;
  const expire = () => {
    const t = [...timers.values()].find((t) => t.delay === 20000);
    expect(t).toBeDefined();
    t?.fn();
  };
  return {
    run,
    requests,
    blobs,
    revoked,
    timers,
    anchor,
    expire,
    get clicks() {
      return clicks;
    },
    get removed() {
      return removed;
    },
  };
}

test("explicit download uses fixed scoped POST, exact JSON bytes and delayed URL cleanup, never automatic IO", async () => {
  const text = JSON.stringify({
      ...sample,
      memories: [{ id: "synthetic", content: "சோதனை 🌦️" }],
    }),
    b = browser(
      async () =>
        new Response(text, { headers: { "content-type": "application/json" } }),
    );
  expect(b.requests).toHaveLength(0);
  await b.run("synthetic-csrf");
  expect(b.requests).toHaveLength(1);
  expect(b.requests[0]?.url).toBe("/api/text-export");
  expect(b.requests[0]?.init).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "X-Saathi-CSRF": "synthetic-csrf",
    },
    body: JSON.stringify({ scope: sample.scope }),
  });
  expect(await b.blobs[0]?.text()).toBe(text);
  expect(b.blobs[0]?.type.split(";")[0]).toBe("application/json");
  expect(b.anchor.download).toBe("saathi-text-export.json");
  expect(b.clicks).toBe(1);
  expect(b.removed).toBe(1);
  expect(b.revoked).toEqual([]);
  expect(b.timers.size).toBe(1);
  const cleanup = [...b.timers.values()][0];
  expect(cleanup?.delay).toBe(30000);
  cleanup?.fn();
  expect(b.revoked).toEqual(["blob:synthetic-download"]);
});

test("auth, unsupported, over-budget and server failures never download or expose error bodies", async () => {
  for (const status of [401, 403, 404, 405, 413, 429, 500, 503]) {
    const b = browser(
      async () => new Response("synthetic-private-server-error", { status }),
    );
    const error = await b.run("synthetic").catch((e: unknown) => e);
    expect(String(error)).not.toContain("synthetic-private-server-error");
    expect(String(error)).toContain("Error:");
    expect(b.clicks).toBe(0);
    expect(b.blobs).toHaveLength(0);
    expect(b.requests).toHaveLength(1);
    expect(b.timers.size).toBe(0);
  }
});

test("wrong MIME, malformed UTF-8/JSON and mismatched scope/version/incomplete results cannot become files", async () => {
  for (const make of [
    () =>
      new Response("<script>synthetic</script>", {
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () => Response.json({ ...sample, format: "future" }),
    () => Response.json({ ...sample, scope: "everything" }),
    () => Response.json({ ...sample, complete_for_scope: false }),
  ]) {
    const b = browser(async () => make());
    await expect(b.run("synthetic")).rejects.toThrow("Text download");
    expect(b.blobs).toHaveLength(0);
    expect(b.timers.size).toBe(0);
  }
});

test("declared and streamed oversized bodies refuse the whole file and cancel the reader", async () => {
  const declared = browser(
    async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "2000001",
        },
      }),
  );
  await expect(declared.run("synthetic")).rejects.toThrow("Text download");
  expect(declared.blobs).toHaveLength(0);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(2_000_001));
    },
    cancel() {
      cancelled = true;
    },
  });
  const b = browser(
    async () =>
      new Response(body, { headers: { "content-type": "application/json" } }),
  );
  await expect(b.run("synthetic")).rejects.toThrow("Text download");
  expect(cancelled).toBe(true);
  expect(b.blobs).toHaveLength(0);
});

test("deadline suppresses late replies and uncooperative body reads without retries or late downloads", async () => {
  let release: (r: Response) => void = () => {};
  const b = browser(
    async () =>
      new Promise<Response>((r) => {
        release = r;
      }),
  );
  const pending = b.run("synthetic");
  b.expire();
  await expect(pending).rejects.toThrow("not confirmed");
  release(Response.json(sample));
  await new Promise((r) => setTimeout(r, 0));
  expect(b.requests[0]?.init.signal?.aborted).toBe(true);
  expect(b.clicks).toBe(0);
  expect(b.blobs).toHaveLength(0);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const stuck = browser(
    async () =>
      new Response(body, { headers: { "content-type": "application/json" } }),
  );
  const reading = stuck.run("synthetic");
  await new Promise((r) => setTimeout(r, 0));
  stuck.expire();
  await expect(reading).rejects.toThrow("not confirmed");
  expect(cancelled).toBe(true);
  expect(stuck.blobs).toHaveLength(0);
});

test("missing session context and failed native click do not leak raw errors or retain URLs", async () => {
  const absent = browser();
  await expect(absent.run("")).rejects.toThrow("workspace");
  expect(absent.requests).toHaveLength(0);
  const b = browser(undefined, true);
  const error = await b.run("synthetic").catch((e: unknown) => e);
  expect(String(error)).not.toContain("synthetic-private-click");
  expect(b.revoked).toEqual(["blob:synthetic-download"]);
  expect(b.removed).toBe(1);
  expect(b.timers.size).toBe(0);
});
