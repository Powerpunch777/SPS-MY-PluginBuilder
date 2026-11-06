import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createBuilderPlatform, readLeadAgentOptions, selectLeadAgent } from "../src/platform.ts";
import { parseLeadAgentOptions } from "../src/domain/lead-agent.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
function fixture() {
  const states = new Map<string, JsonValue>();
  const writes: unknown[] = [];
  const ordinaryWrites: unknown[] = [];
  const rows: Record<string, JsonValue>[] = [{ id: AGENT, companyId: A, name: "Existing Agent", status: "idle",
    adapterConfig: { secret: "must-not-reach-ui", cwd: "private-path" } }];
  const platform = {
    state: {
      async get(key: { scopeId: string; stateKey: string }) { return structuredClone(states.get(`${key.scopeId}:${key.stateKey}`) ?? null); },
      async set(key: { scopeId: string; stateKey: string }, value: JsonValue) {
        ordinaryWrites.push(key); states.set(`${key.scopeId}:${key.stateKey}`, structuredClone(value));
      },
      async compareAndSet(key: { scopeId: string; stateKey: string }, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
        assert.equal(key.stateKey, "lead-agent.v1");
        const stateKey = `${key.scopeId}:${key.stateKey}`;
        const exists = states.has(stateKey);
        const current = states.get(stateKey);
        const matches = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
        if (!matches) return { swapped: false };
        writes.push(key); states.set(stateKey, structuredClone(value));
        return { swapped: true };
      },
      async delete() { throw new Error("No delete permitted"); },
    },
    agents: {
      async list(input: { companyId: string; limit: number }) { assert.deepEqual(input, { companyId: A, limit: 100 }); return structuredClone(rows); },
      sessions: new Proxy({}, { get() { throw new Error("Selecting an Agent must not execute AI or create sessions"); } }),
    },
    events: { async emit() { throw new Error("Unexpected event"); } },
  } as unknown as SpsPlatformInvocationContext;
  return { platform, states, writes, ordinaryWrites, rows };
}

function replaceCompareAndSet(platform: SpsPlatformInvocationContext, method: (...args: any[]) => Promise<unknown>) {
  (platform.state as unknown as { compareAndSet: (...args: any[]) => Promise<unknown> }).compareAndSet = method;
}

test("Lead options expose only bounded same-Workspace identity, never credentials or paths", async () => {
  const f = fixture();
  assert.deepEqual(await readLeadAgentOptions(A, f.platform), { workspaceId: A, revision: 0, selectedAgentId: null,
    agents: [{ id: AGENT, name: "Existing Agent", status: "idle" }] });
  assert.deepEqual(f.writes, []);
  for (const rows of [[{ ...f.rows[0], companyId: B }], [{ ...f.rows[0], name: "x".repeat(501) }],
    [f.rows[0], f.rows[0]], Array.from({ length: 101 }, () => f.rows[0])]) {
    f.platform.agents.list = async () => rows;
    await assert.rejects(readLeadAgentOptions(A, f.platform));
  }
});

test("selection persists separately, is revision checked and never changes Agent settings or snapshot", async () => {
  const f = fixture();
  f.states.set(`${A}:snapshot.v1`, { preserve: "consultation" });
  const selected = await selectLeadAgent(A, { agentId: AGENT, expectedRevision: 0 }, f.platform);
  assert.deepEqual(selected, { saved: true, executionStarted: false, revision: 1 });
  assert.equal((await readLeadAgentOptions(A, f.platform)).selectedAgentId, AGENT);
  assert.deepEqual(f.states.get(`${A}:snapshot.v1`), { preserve: "consultation" });
  assert.equal(f.states.has(`${B}:lead-agent.v1`), false);
  await assert.rejects(selectLeadAgent(A, { agentId: null, expectedRevision: 0 }, f.platform), /changed/);
  assert.deepEqual(await selectLeadAgent(A, { agentId: AGENT, expectedRevision: 1 }, f.platform),
    { saved: true, executionStarted: false, revision: 1 });
  assert.equal(f.writes.length, 1);
  assert.deepEqual(await selectLeadAgent(A, { agentId: null, expectedRevision: 1 }, f.platform),
    { saved: true, executionStarted: false, revision: 2 });
});

test("unavailable or foreign Agents, invalid input and save failure cannot change binding", async () => {
  const f = fixture();
  for (const agentId of [OTHER, AGENT]) {
    if (agentId === AGENT) f.rows[0].status = "paused";
    await assert.rejects(selectLeadAgent(A, { agentId, expectedRevision: 0 }, f.platform), /available Agent/);
  }
  for (const input of [{ agentId: AGENT, expectedRevision: -1 }, { agentId: "bad", expectedRevision: 0 },
    { agentId: AGENT, expectedRevision: 0, targetCompanyId: B }]) {
    await assert.rejects(selectLeadAgent(A, input, f.platform));
  }
  assert.equal(f.writes.length, 0);
  f.rows[0].status = "idle";
  replaceCompareAndSet(f.platform, async () => { throw new Error("Save failed"); });
  await assert.rejects(selectLeadAgent(A, { agentId: AGENT, expectedRevision: 0 }, f.platform), /Save failed/);
});

test("selection CAS preserves an independent writer's newer binding without falling back to state.set", async () => {
  const f = fixture();
  const list = f.platform.agents.list;
  let externalWrite = true;
  f.platform.agents.list = async (...args) => {
    const rows = await list(...args);
    if (externalWrite) {
      externalWrite = false;
      f.states.set(`${A}:lead-agent.v1`, { workspaceId: A, revision: 1, selectedAgentId: OTHER });
    }
    return rows;
  };
  await assert.rejects(selectLeadAgent(A, { agentId: AGENT, expectedRevision: 0 }, f.platform), /changed\. Refresh/);
  assert.deepEqual(f.states.get(`${A}:lead-agent.v1`), { workspaceId: A, revision: 1, selectedAgentId: OTHER });
  assert.equal(f.writes.length, 0);
  assert.equal(f.ordinaryWrites.length, 0);
});

test("unsupported, malformed, revoked and response-lost CAS never falls back or retries", async () => {
  const unsupported = fixture();
  delete (unsupported.platform.state as unknown as { compareAndSet?: unknown }).compareAndSet;
  await assert.rejects(selectLeadAgent(A, { agentId: AGENT, expectedRevision: 0 }, unsupported.platform), /Unsupported Host.*compareAndSet/);
  assert.equal(unsupported.ordinaryWrites.length, 0);

  const getterReceipt = Object.defineProperty({}, "swapped", { enumerable: true, get() { throw new Error("receipt getter ran"); } });
  const symbolReceipt = { swapped: true, [Symbol("extra")]: 1 };
  for (const malformed of [null, true, {}, { applied: true }, { swapped: true, extra: 1 }, { swapped: "yes" },
    getterReceipt, symbolReceipt, Object.assign(Object.create(null), { swapped: true })]) {
    const f = fixture();
    replaceCompareAndSet(f.platform, async () => malformed);
    await assert.rejects(selectLeadAgent(A, { agentId: AGENT, expectedRevision: 0 }, f.platform), /Invalid Host.*receipt/);
    assert.equal(f.ordinaryWrites.length, 0);
  }

  for (const error of ["Host authorization revoked", "Response lost after commit"]) {
    const f = fixture(); let calls = 0;
    replaceCompareAndSet(f.platform, async (key, expected, value) => {
      calls += 1;
      if (error === "Response lost after commit") {
        const actual = await f.platform.state.get(key);
        assert.equal(actual, null);
        f.states.set(`${A}:lead-agent.v1`, structuredClone(value));
      }
      throw new Error(error);
    });
    await assert.rejects(selectLeadAgent(A, { agentId: AGENT, expectedRevision: 0 }, f.platform), new RegExp(error));
    assert.equal(calls, 1);
    assert.equal(f.ordinaryWrites.length, 0);
    if (error === "Response lost after commit") {
      assert.deepEqual(f.states.get(`${A}:lead-agent.v1`), { workspaceId: A, revision: 1, selectedAgentId: AGENT });
    } else assert.equal(f.states.has(`${A}:lead-agent.v1`), false);
  }
});

test("parallel selections cannot overwrite a newer revision", async () => {
  const f = fixture();
  f.rows.push({ id: OTHER, companyId: A, name: "Another Agent", status: "running" });
  const results = await Promise.allSettled([selectLeadAgent(A, { agentId: AGENT, expectedRevision: 0 }, f.platform),
    selectLeadAgent(A, { agentId: OTHER, expectedRevision: 0 }, f.platform)]);
  assert.deepEqual(results.map(value => value.status), ["fulfilled", "rejected"]);
  assert.equal((await readLeadAgentOptions(A, f.platform)).selectedAgentId, AGENT);
  assert.equal(f.writes.length, 1);
});

test("missing selected Agent stays explicitly missing and corrupt bindings fail closed", async () => {
  const f = fixture();
  await selectLeadAgent(A, { agentId: AGENT, expectedRevision: 0 }, f.platform);
  f.rows.length = 0;
  assert.equal((await readLeadAgentOptions(A, f.platform)).selectedAgentId, AGENT);
  await selectLeadAgent(A, { agentId: null, expectedRevision: 1 }, f.platform);
  f.states.set(`${A}:lead-agent.v1`, { workspaceId: B, revision: 1, selectedAgentId: AGENT });
  await assert.rejects(readLeadAgentOptions(A, f.platform), /cross-Workspace/);
  assert.throws(() => parseLeadAgentOptions({ workspaceId: A, revision: 0, selectedAgentId: null, agents: [], secret: "x" }, A));
});

test("Lead selection action rejects unauthenticated and cross-Workspace metadata before reads", async () => {
  const f = fixture();
  const action = createBuilderPlatform().actions.find(value => value.key === "builder.select-lead-agent");
  assert.ok(action);
  let reads = 0;
  f.platform.state.get = async () => { reads += 1; throw new Error("Unexpected read"); };
  for (const [actor, companyId] of [[{ type: "agent", companyId: A }, A], [{ type: "user", companyId: B }, A]] as const) {
    await assert.rejects(Promise.resolve().then(() => action.handler({ agentId: AGENT, expectedRevision: 0 }, { ...f.platform, actor, companyId })));
  }
  await assert.rejects(Promise.resolve().then(() => action.handler({ companyId: B, agentId: AGENT, expectedRevision: 0 },
    { ...f.platform, actor: { type: "user", companyId: A }, companyId: A })));
  assert.equal(reads, 0);
});
