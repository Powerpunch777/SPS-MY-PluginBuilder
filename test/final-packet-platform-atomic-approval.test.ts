import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createBuilderPlatform } from "../src/platform.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";

function platform(actorType: "agent" | "user", options: { hostSupport?: unknown; guardedCas?: boolean } = {}) {
  const rows = new Map<string, JsonValue>();
  const state = {
    async get(key: { stateKey: string }) { return rows.get(key.stateKey) ?? null; },
    async set(key: { stateKey: string }, value: JsonValue) { rows.set(key.stateKey, structuredClone(value)); },
    async delete() { throw new Error("Unexpected delete"); },
    ...(options.guardedCas ? { async guardedGitRefCompareAndSetV1() { return { status: "unsupported" as const, reason: "fixture" }; } } : {}),
  };
  const base = {
    companyId: WORKSPACE,
    actor: { type: actorType, companyId: WORKSPACE, ...(actorType === "user" ? { userId: "user-1" } : {}) },
    state,
    ...(Object.hasOwn(options, "hostSupport") ? { hostSupport: options.hostSupport } : {}),
  };
  return base as unknown as SpsPlatformInvocationContext;
}

test("atomic approval is a user action and requires both the Host report and current SDK method", async () => {
  const contract = createBuilderPlatform() as unknown as {
    actions: Array<{ key: string; handler: (params: unknown, context: unknown) => unknown }>;
    tools: Array<{ name: string }>;
  };
  const action = contract.actions.find(item => item.key === "builder.final-review-decision");
  assert.ok(action);
  assert.equal(contract.tools.some(item => item.name === "builder.final-review-decision"), false);

  const params = { eventId: EVENT, requestId: REQUEST, expectedBaseRevisionId: null, action: "approve" };
  const report = { state: "reported", contractVersion: "1.0", operations: ["state.guardedGitRefCompareAndSetV1"] };
  await assert.rejects(Promise.resolve().then(() => action.handler(params, platform("user", { hostSupport: report }))), /atomic final approval is unsupported/i);
  await assert.rejects(Promise.resolve().then(() => action.handler(params, platform("user", { guardedCas: true }))), /atomic final approval is unsupported/i);
  await assert.rejects(Promise.resolve().then(() => action.handler(params, platform("agent"))), /authenticated user action/);
});
