import assert from "node:assert/strict";
import test from "node:test";
import { createBuilderPlatform } from "../src/platform.ts";

const workspace = "a1234567-b89c-4123-8123-123456789abc";

function fixture() {
  const values = new Map();
  const state = {
    async get(key) { return structuredClone(values.get(JSON.stringify(key)) ?? null); },
    async set(key, value) { values.set(JSON.stringify(key), structuredClone(value)); },
    async delete(key) { values.delete(JSON.stringify(key)); },
    async compareAndSet(key, expected, value) {
      const address = JSON.stringify(key);
      const present = values.has(address);
      const matches = expected.exists
        ? present && JSON.stringify(values.get(address)) === JSON.stringify(expected.value)
        : !present;
      if (matches) values.set(address, structuredClone(value));
      return { swapped: matches };
    },
  };
  return { state };
}

test("registered product-selection data/action use the authenticated single Workspace project", async () => {
  const { state } = fixture();
  const platform = createBuilderPlatform();
  const data = platform.data.find(entry => entry.key === "builder.product-selection");
  const action = platform.actions.find(entry => entry.key === "builder.save-product-selection");
  assert(data);
  assert(action);

  assert.equal(await data.handler({ companyId: workspace }, { state }), null);
  const result = await action.handler({ requestId: "c1234567-b89c-4123-8123-123456789abc",
    expectedRevisionId: null, selection: { sourceContext: { sourceIds: ["consultation-1"], revisionRefs: [] } } },
  { companyId: workspace, actor: { type: "user", companyId: workspace }, state });
  assert.equal(result.status, "saved");
  const current = await data.handler({ companyId: workspace }, { state });
  assert.equal(current.workspaceId, workspace);
  assert.equal(current.projectId, workspace);
  assert.equal(current.status, "incomplete");
});
