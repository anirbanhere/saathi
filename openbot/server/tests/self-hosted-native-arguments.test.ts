import { expect, test } from "bun:test";
import { nativeToolCatalog } from "../src/self-hosted/native-tool-catalog";
import {
  clinicArguments,
  manualArguments,
} from "../src/self-hosted/native-tool-contracts";

test("catalogue structural schemas come from shared strict contracts without replacing calendar checks", () => {
  const [clinic, manual] = nativeToolCatalog();
  expect(clinic.schema.additionalProperties).toBe(false);
  expect(manual.schema.additionalProperties).toBe(false);
  expect(clinicArguments.safeParse({ date: "2026-02-30" }).success).toBe(false);
  expect(clinicArguments.safeParse({ date: "2028-02-29" }).success).toBe(true);
  expect(
    clinicArguments.safeParse({ date: "2028-02-29", grant: true }).success,
  ).toBe(false);
  expect(
    manualArguments.safeParse({ instructions: "x".repeat(1000) }).success,
  ).toBe(true);
  expect(
    manualArguments.safeParse({ instructions: "x".repeat(1001) }).success,
  ).toBe(false);
  expect(manualArguments.safeParse({ instructions: "" }).success).toBe(false);
  expect(
    manualArguments.safeParse({ instructions: "text", execute: true }).success,
  ).toBe(false);
  expect(manual.schema.properties?.instructions).toMatchObject({
    minLength: 1,
    maxLength: 1000,
  });
  expect(clinic.runtimeChecks).toContain("exact_user_confirmed_date");
});
