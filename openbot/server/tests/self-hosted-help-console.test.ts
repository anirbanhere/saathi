import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const reply = (locale: string) => ({
  format: "saathi-control-read-v1",
  intent: "help",
  locale,
  action_executed: false,
  message: "Synthetic guidance",
});
function world(
  api: (...args: unknown[]) => Promise<unknown> = async (...args) =>
    reply((args[1] as { locale: string }).locale),
) {
  const events: Record<string, () => void> = {},
    requests: unknown[][] = [],
    timers = new Map<number, () => void>(),
    errors: string[] = [];
  let focused = "",
    serial = 0,
    busy = false,
    pending: Promise<void> = Promise.resolve(),
    success = "";
  const element = (id: string) => ({
    value: "en-IN",
    disabled: false,
    textContent: "",
    lang: "",
    focus: () => {
      focused = id;
    },
    addEventListener: (event: string, handler: () => void) => {
      events[`${id}:${event}`] = handler;
    },
  });
  const elements = {
    "#help-locale": element("#help-locale"),
    "#help-show": element("#help-show"),
    "#help-output": element("#help-output"),
  };
  let component: { setBusy: (busy: boolean) => void };
  const run = (
    action: () => Promise<void>,
    focus: { focus: () => void },
    message: string,
  ) => {
    if (busy) return;
    busy = true;
    component.setBusy(true);
    pending = (async () => {
      try {
        await action();
        success = message;
        focus.focus();
      } catch (e) {
        errors.push(String(e));
      } finally {
        busy = false;
        component.setBusy(false);
      }
    })();
  };
  const source = readFileSync(
    resolve(import.meta.dir, "../../../saathi-web/help.js"),
    "utf8",
  ).replace("export function", "function");
  const create = runInNewContext(`${source}\ncreateHelpConsole`, {
    document: {
      querySelector: (s: string) => elements[s as keyof typeof elements],
    },
    AbortController,
    setTimeout: (fn: () => void) => {
      const id = ++serial;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  }) as (d: {
    api: (...args: unknown[]) => Promise<unknown>;
    run: typeof run;
  }) => { setBusy: (b: boolean) => void };
  component = create({
    api: async (...args) => {
      requests.push(args);
      return api(...args);
    },
    run,
  });
  return {
    elements,
    requests,
    errors,
    timers,
    click() {
      events["#help-show:click"]?.();
      return pending;
    },
    expire() {
      [...timers.values()][0]?.();
    },
    get focused() {
      return focused;
    },
    get success() {
      return success;
    },
  };
}
test("help does no initial IO, pins locale, uses shared busy guard and safely renders text with accurate status", async () => {
  let release: (r: unknown) => void = () => {};
  const b = world(
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  expect(b.requests).toHaveLength(0);
  b.elements["#help-locale"].value = "ta-IN";
  const pending = b.click();
  expect(b.elements["#help-locale"].disabled).toBe(true);
  void b.click();
  expect(b.requests).toHaveLength(1);
  expect(b.requests[0]?.slice(0, 3)).toEqual([
    "/api/control-read",
    { intent: "help", locale: "ta-IN" },
    "POST",
  ]);
  release({ ...reply("ta-IN"), message: "<img src=x onerror=alert(1)> தமிழ்" });
  await pending;
  expect(b.elements["#help-output"].textContent).toBe(
    "<img src=x onerror=alert(1)> தமிழ்",
  );
  expect(b.elements["#help-output"].lang).toBe("ta-IN");
  expect(b.focused).toBe("#help-output");
  expect(b.success).not.toContain("Saved");
  expect(b.elements["#help-locale"].disabled).toBe(false);
  expect(b.timers.size).toBe(0);
});
test("supported locales are explicit; wrong response identity, action or oversized guidance fail safely", async () => {
  for (const locale of ["en-IN", "hi-IN", "ta-IN"]) {
    const b = world();
    b.elements["#help-locale"].value = locale;
    await b.click();
    expect(b.elements["#help-output"].lang).toBe(locale);
    expect(b.errors).toEqual([]);
  }
  for (const change of [
    { locale: "hi-IN" },
    { format: "future" },
    { intent: "status" },
    { action_executed: true },
    { message: "X".repeat(6001) },
    { message: "" },
  ]) {
    const b = world(async () => ({ ...reply("en-IN"), ...change }));
    await b.click();
    expect(b.elements["#help-output"].textContent).not.toBe(
      "Synthetic guidance",
    );
    expect(b.errors).toHaveLength(1);
    expect(b.focused).toBe("#help-output");
  }
  const b = world();
  b.elements["#help-locale"].value = "constructor";
  await b.click();
  expect(b.requests).toHaveLength(0);
  expect(b.errors).toHaveLength(1);
});
test("deadline ignores late answers, aborts the request and never retries or leaves controls locked", async () => {
  let release: (r: unknown) => void = () => {};
  const b = world(
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const pending = b.click();
  b.expire();
  await pending;
  const before = b.elements["#help-output"].textContent;
  release(reply("en-IN"));
  await new Promise((r) => setTimeout(r, 0));
  expect(b.elements["#help-output"].textContent).toBe(before);
  expect((b.requests[0]?.[3] as AbortSignal | undefined)?.aborted).toBe(true);
  expect(b.requests).toHaveLength(1);
  expect(b.elements["#help-show"].disabled).toBe(false);
});
test("expired-session and network errors are fixed localized messages without private server text", async () => {
  for (const status of [401, 403, 404, 503, undefined]) {
    const b = world(async () => {
      throw Object.assign(Error("synthetic-private-server"), { status });
    });
    b.elements["#help-locale"].value = "hi-IN";
    await b.click();
    expect(b.errors[0]).not.toContain("synthetic-private-server");
    expect(b.elements["#help-output"].lang).toBe("hi-IN");
    expect(b.requests).toHaveLength(1);
    expect(b.timers.size).toBe(0);
  }
});
