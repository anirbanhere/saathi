import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const id = "11111111-1111-4111-8111-111111111111";
const result = (kind = "task_plan", locale = "en-IN") => ({
  format: "saathi-control-read-v1",
  intent: "status",
  locale,
  action_executed: false,
  observed_at: 1,
  target: { kind, id },
  evidence_scope: "stored_task_metadata",
  status: {
    mode: kind === "task_plan" ? "draft_only" : "mock",
    stored_state: "CANCELLED",
    code: "cancelled",
    pending: false,
    updated_at: 1,
  },
  message: "Synthetic state",
  notice: "Synthetic draft/mock notice",
  pending_note: null,
});
function world(
  api: (...args: unknown[]) => Promise<unknown> = async (...args) => {
    const input = args[1] as { target: { kind: string }; locale: string };
    return result(input.target.kind, input.locale);
  },
) {
  const requests: unknown[][] = [],
    errors: string[] = [],
    timers = new Map<number, () => void>();
  let focused: Node | null = null,
    serial = 0,
    busy = false,
    pending: Promise<void> = Promise.resolve(),
    success = "";
  class Node {
    children: Node[] = [];
    events: Record<string, () => void> = {};
    attributes: Record<string, string> = {};
    value = "en-IN";
    disabled = false;
    textContent: string;
    lang = "";
    className = "";
    type = "";
    constructor(
      public tag: string,
      text = "",
    ) {
      this.textContent = text;
    }
    addEventListener(e: string, fn: () => void) {
      this.events[e] = fn;
    }
    setAttribute(k: string, v: string) {
      this.attributes[k] = v;
    }
    append(...nodes: Node[]) {
      this.children.push(...nodes);
    }
    focus() {
      focused = this;
    }
  }
  const language = new Node("select"),
    show = new Node("button"),
    help = new Node("p");
  const elements: Record<string, Node> = {
    "#help-locale": language,
    "#help-show": show,
    "#help-output": help,
  };
  let component: {
    setBusy: (v: boolean) => void;
    statusControl: (kind: string, id: string, label?: string) => Node;
  };
  const run = (action: () => Promise<void>, focus: Node, message: string) => {
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
    document: { querySelector: (s: string) => elements[s] },
    AbortController,
    setTimeout: (fn: () => void) => {
      const k = ++serial;
      timers.set(k, fn);
      return k;
    },
    clearTimeout: (k: number) => timers.delete(k),
  }) as (deps: {
    api: (...args: unknown[]) => Promise<unknown>;
    run: typeof run;
    el: (tag: string, text?: string) => Node;
  }) => typeof component;
  component = create({
    api: async (...args) => {
      requests.push(args);
      return api(...args);
    },
    run,
    el: (tag, text) => new Node(tag, text),
  });
  const control = (
    kind = "task_plan",
    target = id,
    label = "Synthetic title",
  ) => {
    const node = component.statusControl(kind, target, label),
      button = node.children[0],
      output = node.children[1];
    if (!button || !output) throw Error("No control");
    return {
      node,
      button,
      output,
      click() {
        button.events.click?.();
        return pending;
      },
    };
  };
  return {
    component,
    control,
    language,
    requests,
    errors,
    timers,
    get focused() {
      return focused;
    },
    get success() {
      return success;
    },
    expire() {
      [...timers.values()][0]?.();
    },
  };
}

test("per-card status pins only owned target/locale, uses one explicit read and preserves pending/draft notices", async () => {
  let release: (x: unknown) => void = () => {};
  const b = world(
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const c = b.control("task_plan", id, "<private card title>");
  expect(b.requests).toHaveLength(0);
  b.language.value = "ta-IN";
  const pending = c.click();
  void c.click();
  expect(b.requests).toHaveLength(1);
  expect(b.language.disabled).toBe(true);
  expect(b.requests[0]?.slice(0, 3)).toEqual([
    "/api/control-read",
    { intent: "status", locale: "ta-IN", target: { kind: "task_plan", id } },
    "POST",
  ]);
  expect(JSON.stringify(b.requests)).not.toContain("private card title");
  release({
    ...result("task_plan", "ta-IN"),
    status: { ...result().status, pending: true },
    message: "<img src=x onerror=alert(1)> தமிழ்",
    pending_note: "Synthetic pending acknowledgement",
  });
  await pending;
  expect(c.output.textContent).toContain("<img src=x onerror=alert(1)> தமிழ்");
  expect(c.output.textContent).toContain("Synthetic draft/mock notice");
  expect(c.output.textContent).toContain("pending acknowledgement");
  expect(c.output.children).toEqual([]);
  expect(c.output.lang).toBe("ta-IN");
  expect(b.focused).toBe(c.output);
  expect(b.success).not.toContain("Saved");
  expect(b.timers.size).toBe(0);
});

test("wrong kind/id/locale/action/mode/code/scope or metadata bounds cannot be rendered as a status", async () => {
  for (const patch of [
    { target: { kind: "demo_appointment", id } },
    {
      target: { kind: "task_plan", id: "22222222-2222-4222-8222-222222222222" },
    },
    { locale: "hi-IN" },
    { action_executed: true },
    { evidence_scope: "verified_receipt" },
    { status: { ...result().status, mode: "live" } },
    { status: { ...result().status, code: "mock_confirmed" } },
    { status: { ...result().status, pending: true } },
    { notice: "X".repeat(2001) },
    { observed_at: NaN },
  ]) {
    const b = world(async () => ({ ...result(), ...patch })),
      c = b.control();
    await c.click();
    expect(b.errors).toHaveLength(1);
    expect(c.output.textContent).not.toContain("Synthetic state");
    expect(c.output.textContent).not.toContain("Synthetic draft/mock notice");
  }
});

test("expired approval remains a mock snapshot and invalid target labels cannot generate reads", async () => {
  const b = world(async () => ({
    ...result("demo_appointment", "hi-IN"),
    status: {
      ...result("demo_appointment").status,
      stored_state: "APPROVAL_PENDING",
      code: "approval_expired",
    },
    message: "Synthetic expiry",
    notice: "Mock only: no real appointment",
  }));
  b.language.value = "hi-IN";
  const c = b.control("demo_appointment");
  await c.click();
  expect(c.output.textContent).toContain("Synthetic expiry");
  expect(c.output.textContent).toContain("no real appointment");
  expect(c.output.textContent).not.toContain("APPROVAL_PENDING");
  for (const [kind, target] of [
    ["constructor", id],
    ["task_plan", "bad-id"],
    ["task_plan", `${id}?owner=foreign`],
  ] as const) {
    const node = b.component.statusControl(kind, target);
    expect(node.children).toHaveLength(0);
  }
  expect(b.requests).toHaveLength(1);
});

test("deadline, late reply and foreign/expired/network errors neither refresh tasks nor expose raw text", async () => {
  let release: (r: unknown) => void = () => {};
  const b = world(
      async () =>
        new Promise((r) => {
          release = r;
        }),
    ),
    c = b.control();
  const pending = c.click();
  b.expire();
  await pending;
  const before = c.output.textContent;
  release(result());
  await new Promise((r) => setTimeout(r, 0));
  expect(c.output.textContent).toBe(before);
  expect((b.requests[0]?.[3] as AbortSignal | undefined)?.aborted).toBe(true);
  expect(b.requests).toHaveLength(1);
  for (const status of [401, 403, 404, 503, undefined]) {
    const w = world(async () => {
        throw Object.assign(Error("synthetic-private-error"), { status });
      }),
      item = w.control();
    await item.click();
    expect(w.errors[0]).not.toContain("synthetic-private-error");
    expect(w.requests).toHaveLength(1);
    expect(w.timers.size).toBe(0);
  }
});
