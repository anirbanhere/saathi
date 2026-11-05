import { z } from "zod";

const dateShape = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const exactDate = dateShape.refine((value) => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
});
const clinicShape = z.object({ date: dateShape }).strict();
export const clinicArguments = clinicShape.extend({ date: exactDate });
export const manualArguments = z
  .object({ instructions: z.string().min(1).max(1000) })
  .strict();

/** Structural metadata only: calendar and confirmed-date checks remain runtime policy. */
export function nativeArgumentSchemas() {
  const options = {
    target: "draft-2020-12",
    unrepresentable: "throw",
    metadata: z.registry<Record<string, unknown>>(),
  } as const;
  return {
    clinic: z.toJSONSchema(clinicShape, options),
    manual: z.toJSONSchema(manualArguments, options),
  };
}
