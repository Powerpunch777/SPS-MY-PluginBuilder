import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createBuilderPlatform, importConsultation, readBuilderSnapshot } from "../src/platform.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";

function fakePlatform() {
  const rows = new Map<string, JsonValue>();
  const writes: string[] = [];
  const platform = {
    state: {
      async get(key: Record<string, unknown>) { return structuredClone(rows.get(String(key.scopeId)) ?? null); },
      async set(key: Record<string, unknown>, value: JsonValue) { writes.push(String(key.scopeId)); rows.set(String(key.scopeId), structuredClone(value)); },
      async delete() { throw new Error("Unexpected delete"); },
    },
    agents: new Proxy({}, { get() { throw new Error("Consultation import must not execute AI"); } }),
    events: { async emit() { throw new Error("Unexpected event"); } },
  } as unknown as SpsPlatformInvocationContext;
  return { platform, rows, writes };
}

test("selected consultation text persists only in its trusted Workspace without starting analysis", async () => {
  const { platform, writes } = fakePlatform();
  assert.equal((await readBuilderSnapshot(A, platform)).messages.length, 0);
  assert.deepEqual(await importConsultation(A, { requestId, text: "Selected consultation text" }, platform),
    { saved: true, analysisStarted: false, revision: 1 });
  assert.equal((await readBuilderSnapshot(A, platform)).messages[0]?.text, "Selected consultation text");
  assert.equal((await readBuilderSnapshot(B, platform)).messages.length, 0);
  assert.deepEqual(writes, [A]);
});

test("duplicate and concurrent import requests are idempotent and conflicting reuse fails", async () => {
  const { platform, writes } = fakePlatform();
  const input = { requestId, text: "Selected text" };
  const results = await Promise.all([importConsultation(A, input, platform), importConsultation(A, input, platform)]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(writes, [A]);
  await assert.rejects(importConsultation(A, { ...input, text: "Different" }, platform), /different input/);
  assert.equal((await readBuilderSnapshot(A, platform)).messages.length, 1);
});

test("malformed input, cross-Workspace stored data and failed saves never report success", async () => {
  const { platform, rows, writes } = fakePlatform();
  for (const input of [{ requestId, text: "" }, { requestId, text: "x", companyId: B },
    { requestId: "bad", text: "x" }, { requestId, text: "x".repeat(65_537) }]) {
    await assert.rejects(importConsultation(A, input, platform));
  }
  assert.deepEqual(writes, []);
  rows.set(A, await readBuilderSnapshot(B, platform) as unknown as JsonValue);
  await assert.rejects(readBuilderSnapshot(A, platform), /different Workspace/);
  rows.clear();
  platform.state.set = async () => { throw new Error("Save failed"); };
  await assert.rejects(importConsultation(A, { requestId, text: "x" }, platform), /Save failed/);
});

test("the action requires authenticated user context and uses Host scope rather than request scope", async () => {
  const contract = createBuilderPlatform();
  const action = contract.actions[0];
  assert.ok(action);
  const { platform } = fakePlatform();
  await assert.rejects(Promise.resolve().then(() => action.handler({ requestId, text: "x" }, {
    ...platform, companyId: A, actor: { type: "agent", companyId: A },
  })), /authenticated user/);
  await assert.rejects(Promise.resolve().then(() => action.handler({ requestId, text: "x", companyId: B }, {
    ...platform, companyId: A, actor: { type: "user", companyId: A },
  })));
});
