import { createHash } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
export function taskQaCriteria(acceptance: readonly string[], passCriteria: readonly string[], implementationAcceptance: readonly string[] = []) {
  return Object.freeze([...implementationAcceptance.map((text, index) => Object.freeze({ criterionId: `implementation:${index + 1}:${digest(text)}`, text })),
    ...acceptance.map((text, index) => Object.freeze({ criterionId: `acceptance:${index + 1}:${digest(text)}`, text })),
    ...passCriteria.map((text, index) => Object.freeze({ criterionId: `test-plan:${index + 1}:${digest(text)}`, text }))]);
}
