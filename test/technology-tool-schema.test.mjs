import assert from "node:assert/strict";
import test from "node:test";
import { PUBLISH_TECHNOLOGY_DECISIONS_TOOL, READ_TECHNOLOGY_DECISIONS_TOOL } from "../src/tool-declarations.mjs";

// Contract-shape assertions, not a replacement JSON Schema validator.
test("technology tool schema advertises reason and research-level cross-field constraints", () => {
  const schema = PUBLISH_TECHNOLOGY_DECISIONS_TOOL.parametersSchema;
  const entry = schema.properties.register.properties.entries.items;
  assert.deepEqual(entry.anyOf, [
    { properties: { selectionReason: { pattern: "\\S" } } },
    { properties: { nonSelectionReason: { pattern: "\\S" } } },
  ]);
  const license = entry.properties.licenseReview;
  assert.deepEqual(license.oneOf[0], { properties: { status: { const: "unreviewed" }, licenseExpression: { type: "null" } } });
  assert.equal(license.oneOf[1].properties.status.const, "reported-reviewed");
  assert.equal(license.oneOf[1].properties.evidenceRefs.minItems, 1);
  assert.equal(license.oneOf[1].properties.licenseExpression.pattern, "\\S");
  assert.deepEqual(entry.properties.verification.oneOf, [
    { properties: { level: { const: "not-verified" }, evidenceRefs: { maxItems: 0 } } },
    { properties: { level: { enum: ["documentation-only", "reported-integration-test"] }, evidenceRefs: { minItems: 1 } } },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
  assert.equal(schema.additionalProperties, false);
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual(READ_TECHNOLOGY_DECISIONS_TOOL.parametersSchema.required, ["projectId"]);
});
