import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createProductSelectionStore, saveProductSelectionAction } from "../src/product-selection/store.ts";

const workspace = "a1234567-b89c-4123-8123-123456789abc";
const other = "b1234567-b89c-4123-8123-123456789abc";
const firstId = "c1234567-b89c-4123-8123-123456789abc";
const secondId = "d1234567-b89c-4123-8123-123456789abc";
const sourceContext = { sourceIds: ["consultation-1"], revisionRefs: [] };
const proposal = { sourceContext, productId: "M02", productTier: "M", route: "CUSTOM",
  deliveryTargets: ["web-api"], deliveredProductUsesAI: false };

function fixture() {
  const values = new Map<string, JsonValue>();
  let writes = 0;
  const state = {
    async get(key: SpsStateKey) {
      return structuredClone(values.get(JSON.stringify(key)) ?? null);
    },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const address = JSON.stringify(key);
      const swapped = expected.exists
        ? values.has(address) && JSON.stringify(values.get(address)) === JSON.stringify(expected.value)
        : !values.has(address);
      if (swapped) {
        values.set(address, structuredClone(value));
        writes += 1;
      }
      return { swapped };
    },
  };
  return { state, writes: () => writes };
}

test("product selection drafts survive reload, with no implied approval or verified source", async () => {
  const f = fixture();
  const store = createProductSelectionStore(workspace, "project", f.state);
  assert.equal(await store.current(), null);
  const saved = await store.save({ requestId: firstId, expectedRevisionId: null, selection: { sourceContext } });
  assert.equal(saved.status, "saved");
  const reopened = createProductSelectionStore(workspace, "project", f.state);
  assert.equal((await reopened.current())?.status, "incomplete");
  await reopened.save({ requestId: secondId, expectedRevisionId: firstId, selection: proposal });
  const record = await reopened.current();
  assert.equal(record?.sequence, 2);
  assert.equal(record?.draft?.approval, "not-approved");
  assert.equal(record?.draft?.sourceContext.verification, "reported-unverified");
  assert.equal(record?.draft?.deliveredProductUsesAI, false);
  assert.equal(await createProductSelectionStore(other, "project", f.state).current(), null);
  assert.equal(await createProductSelectionStore(workspace, "other-project", f.state).current(), null);
});

test("identical replay is read-only, changed reuse and stale saves cannot overwrite the head", async () => {
  const f = fixture();
  const store = createProductSelectionStore(workspace, "project", f.state);
  const input = { requestId: firstId, expectedRevisionId: null, selection: proposal };
  assert.equal((await store.save(input)).status, "saved");
  const count = f.writes();
  assert.equal((await store.save(input) as { replayed?: boolean }).replayed, true);
  await assert.rejects(() => store.save({ ...input, selection: { ...proposal, deliveredProductUsesAI: true } }), /different draft/);
  assert.deepEqual(await store.save({ ...input, requestId: secondId }), { status: "conflict", actualRevisionId: firstId });
  assert.equal(f.writes(), count);
});

test("concurrent edits from the same base publish only one current draft", async () => {
  const f = fixture();
  const store = createProductSelectionStore(workspace, "project", f.state);
  const results = await Promise.all([
    store.save({ requestId: firstId, expectedRevisionId: null, selection: proposal }),
    store.save({ requestId: secondId, expectedRevisionId: null, selection: { sourceContext } }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ["conflict", "saved"]);
  assert.equal((await store.current())?.sequence, 1);
});

test("retry after a lost head receipt resolves the already-saved draft without rewriting", async () => {
  const f = fixture();
  const store = createProductSelectionStore(workspace, "project", {
    ...f.state,
    async compareAndSet(key, expected, value) {
      const receipt = await f.state.compareAndSet(key, expected, value);
      if (receipt.swapped && key.stateKey.startsWith("product-selection-head.")) throw new Error("Lost receipt");
      return receipt;
    },
  });
  const input = { requestId: firstId, expectedRevisionId: null, selection: proposal };
  await assert.rejects(() => store.save(input), /Lost receipt/);
  const count = f.writes();
  const result = await store.save(input);
  assert.equal(result.status, "saved");
  if (result.status === "saved") assert.equal(result.replayed, true);
  assert.equal(f.writes(), count);
});

test("only a trusted same-Workspace user action can save, with no caller destination", async () => {
  const f = fixture();
  const user = { companyId: workspace, actor: { type: "user" as const, companyId: workspace }, state: f.state };
  const input = { requestId: firstId, expectedRevisionId: null, selection: proposal };
  await assert.rejects(() => saveProductSelectionAction(input, { ...user, actor: { ...user.actor, type: "agent" } }), /authenticated/);
  await assert.rejects(() => saveProductSelectionAction(input, { ...user, actor: { ...user.actor, companyId: other } }), /authenticated/);
  await assert.rejects(() => saveProductSelectionAction({ ...input, companyId: other }, user), /metadata/);
  await assert.rejects(() => saveProductSelectionAction({ ...input, selection: { ...proposal, projectId: other } }, user), /fields/);
  await assert.rejects(() => saveProductSelectionAction(input, { ...user, state: { get: f.state.get } }), /compareAndSet/);
  assert.equal(f.writes(), 0);
  const result = await saveProductSelectionAction({ ...input, companyId: workspace }, user);
  assert.equal(result.status, "saved");
  assert.equal((await createProductSelectionStore(workspace, workspace, f.state).current())?.draft?.projectId, workspace);
});
