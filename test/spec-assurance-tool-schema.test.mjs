import assert from "node:assert/strict";
import test from "node:test";
import { PROPOSE_FIRST_DESIGN_REVIEW_TOOL } from "../src/spec-assurance/tool-declarations.mjs";

const schema = PROPOSE_FIRST_DESIGN_REVIEW_TOOL.parametersSchema;
test("initial review tools describe exact Domain Pack nested inputs", () => {
  const pack = schema.properties.pack.properties;
  assert.equal(pack.rules.maxItems, 1000);
  assert.deepEqual(pack.rules.items.required, ["id", "requirementIds", "appliesWhen", "requiresCheck"]);
  assert.equal(pack.rules.items.properties.requirementIds.minItems, 1);
  assert.equal(pack.rules.items.properties.appliesWhen.additionalProperties, false);
  assert.deepEqual(Object.keys(pack.applicability.properties), ["all", "any", "none"]);
  assert.deepEqual(pack.transitions.items.required, ["from", "event", "to"]);
  assert.deepEqual(pack.exceptions.items.required, ["id", "from", "event", "to"]);
  assert.deepEqual(pack.excludedCombinations.items.required, ["from", "event", "to", "reason"]);
  assert.equal(Object.hasOwn(pack, "identity"), false);
});

test("initial review model schema distinguishes static decisions and exact source quotes", () => {
  const model = schema.properties.designModel.properties;
  assert.deepEqual(model.coverageRules.items.required, ["id", "requiresCheck", "requiredEvidenceKinds"]);
  assert.deepEqual(model.coverageTargets.items.properties.targetKind.enum, ["requirement", "ac"]);
  assert.deepEqual(model.scenarios.items.required, ["id", "state", "event", "nextState", "exceptionId"]);
  assert.equal(model.itemDecisions.items.properties.status.enum.includes("VERIFIED"), false);
  assert.deepEqual(model.acceptanceCriteria.items.required, ["requirementId", "acId", "sourceId", "quote"]);
  for (const forbidden of ["identity", "digest", "approval", "sourceDigest", "qaVerdict"]) {
    assert.equal(Object.hasOwn(model, forbidden), false);
  }
});
