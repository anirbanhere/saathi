import { expect, test } from "bun:test";
import {
  nativeToolCatalog,
  nativeToolDescription,
} from "../src/self-hosted/native-tool-catalog";
import {
  planningInstructions,
  validatePlan,
} from "../src/self-hosted/plan-contract";

test("native catalogue describes only existing mock/manual capabilities and cannot grant execution", () => {
  const catalog = nativeToolCatalog();
  expect(catalog.map((t) => t.id)).toEqual([
    "demo.clinic.options",
    "handoff.manual",
  ]);
  for (const tool of catalog) {
    expect(tool.executionAllowed).toBe(false);
    expect(tool.auth).toBe("none");
    expect(tool.externalSideEffects).toBe(false);
    expect(tool.localToolFee).toBe(0);
    expect(tool.schema.additionalProperties).toBe(false);
    expect(tool).not.toHaveProperty("execute");
    expect(tool).not.toHaveProperty("preview");
  }
  expect(catalog[0].testMode).toBe("mock");
  expect(catalog[1].testMode).toBe("unverified_manual_draft");
  expect(planningInstructions).toContain(nativeToolDescription());
  expect(JSON.stringify(catalog)).not.toMatch(/https?:|api_key|bearer|oauth/i);
});

test("catalogue copies cannot change future planner policy or strict runtime argument validation", () => {
  const first = nativeToolCatalog();
  const before = nativeToolDescription();
  Reflect.set(first[0], "executionAllowed", true);
  Reflect.set(first[0].schema.properties, "secret", { type: "string" });
  expect(nativeToolDescription()).toBe(before);
  expect(nativeToolCatalog()[0].executionAllowed).toBe(false);
  const input = {
    request_id: "catalog",
    goal: "Synthetic",
    locale: "en-IN" as const,
    date: "2026-11-06",
  };
  const plan = (tool: string, args: unknown, risk = "READ") => ({
    goal: input.goal,
    status: "ready",
    question: null,
    unavailable_reason: null,
    steps: [
      {
        id: "s1",
        description: "Synthetic",
        prerequisites: [],
        tool,
        risk,
        approval_required: false,
        arguments: args,
        expected_output: "Synthetic",
        timeout_ms: 1000,
        compensation: "none",
      },
    ],
  });
  expect(
    validatePlan(input, plan("demo.clinic.options", { date: input.date }))
      .steps,
  ).toHaveLength(1);
  expect(
    validatePlan(
      input,
      plan("handoff.manual", { instructions: "Unverified" }, "DRAFT"),
    ).steps,
  ).toHaveLength(1);
  for (const tool of [
    "__proto__",
    "constructor",
    "real.clinic.book",
    "mcp.pay",
  ])
    expect(() =>
      validatePlan(input, plan(tool, { date: input.date })),
    ).toThrow();
  for (const args of [
    { date: "2026-02-30" },
    { date: "2026-11-07" },
    { date: input.date, grant: true },
  ])
    expect(() =>
      validatePlan(input, plan("demo.clinic.options", args)),
    ).toThrow();
});
