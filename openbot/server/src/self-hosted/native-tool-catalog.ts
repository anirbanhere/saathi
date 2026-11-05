/** Fixed descriptive catalogue, not registration, permission or an executor. */
const tools = [
  {
    id: "demo.clinic.options",
    title: "Controlled mock clinic slots",
    risk: "READ",
    provider: "local_demo_clinic",
    auth: "none",
    permissions: ["owned_draft", "explicit_read_request", "confirmed_date"],
    dataCategories: ["confirmed_date"],
    localToolFee: 0,
    inferenceFeesIncluded: false,
    testMode: "mock",
    idempotency: "owned_task_cached_observation",
    previewSupport: "none",
    dispatch: "existing_fixed_plan_reads",
    executionAllowed: false,
    externalSideEffects: false,
    schema: {
      type: "object",
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      },
      required: ["date"],
      additionalProperties: false,
    },
    runtimeChecks: ["valid_calendar_date", "exact_user_confirmed_date"],
    plannerDescription:
      'demo.clinic.options (READ; arguments {"date":"YYYY-MM-DD"}; controlled mock clinic slots, no genuine booking)',
  },
  {
    id: "handoff.manual",
    title: "Unverified manual guidance",
    risk: "DRAFT",
    provider: "local_manual_draft",
    auth: "none",
    permissions: ["owned_draft", "explicit_read_request"],
    dataCategories: ["unverified_instruction_text"],
    localToolFee: 0,
    inferenceFeesIncluded: false,
    testMode: "unverified_manual_draft",
    idempotency: "owned_task_cached_observation",
    previewSupport: "none",
    dispatch: "existing_fixed_plan_reads",
    executionAllowed: false,
    externalSideEffects: false,
    schema: {
      type: "object",
      properties: {
        instructions: { type: "string", minLength: 1, maxLength: 1000 },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
    runtimeChecks: ["strict_plan_contract", "unverified_draft_only"],
    plannerDescription:
      'handoff.manual (DRAFT; arguments {"instructions":string}; unverified manual guidance, no external action)',
  },
] as const;

/** A fresh detached metadata snapshot; no function, transport or mutable registry escapes. */
export function nativeToolCatalog() {
  return structuredClone(tools);
}

/** Only trusted built-ins contribute text; models/MCP pages cannot add capabilities. */
export function nativeToolDescription() {
  return tools.map((tool) => tool.plannerDescription).join(", ");
}
