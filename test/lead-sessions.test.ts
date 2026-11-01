import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { createBuilderPlatform, prepareLeadSessions, readLeadSessions, selectLeadAgent } from "../src/platform.ts";
import { parseLeadSessions } from "../src/domain/lead-sessions.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const input = { agentId: AGENT, expectedRevision: 1 };

function fixture() {
  const states = new Map<string, JsonValue>();
  const sessions = new Map<string, string>();
  const calls: Array<{ agentId: string; companyId: string; taskKey: string; expectedSessionId?: string }> = [];
  const platform = {
    state: {
      async get(key: { scopeId: string; stateKey: string }) { return structuredClone(states.get(`${key.scopeId}:${key.stateKey}`) ?? null); },
      async set(key: { scopeId: string; stateKey: string }, value: JsonValue) {
        states.set(`${key.scopeId}:${key.stateKey}`, structuredClone(value));
      },
      async delete() { throw new Error("Session preparation must not delete state"); },
    },
    agents: {
      async list({ companyId }: { companyId: string }) { return [AGENT, OTHER].map(id => ({ id, companyId, name: id, status: "idle" })); },
      sessions: {
        async ensure(agentId: string, companyId: string, options: { taskKey: string; expectedSessionId?: string }) {
          calls.push({ agentId, companyId, ...options });
          const key = JSON.stringify([companyId, agentId, options.taskKey]);
          const known = sessions.get(key);
          if (options.expectedSessionId !== undefined && options.expectedSessionId !== known) throw new Error("Expected session unavailable");
          if (known) return { sessionId: known, created: false };
          const id = `${String(sessions.size + 1).padStart(8, "0")}-5555-4555-8555-555555555555`;
          sessions.set(key, id);
          return { sessionId: id, created: true };
        },
        async create() { throw new Error("No create fallback"); },
        async list() { throw new Error("No list fallback"); },
        async sendMessage() { throw new Error("Must not execute AI"); },
      },
    },
  } as unknown as SpsPlatformInvocationContext;
  return { platform, states, sessions, calls };
}

test("explicit preparation binds three distinct Lead sessions and rechecks exact known IDs", async () => {
  const f = fixture();
  assert.deepEqual((await readLeadSessions(A, f.platform)).sessions, { main: null, "cto-inbox": null, decisions: null });
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await prepareLeadSessions(A, input, f.platform), { saved: true, executionStarted: false, sessionsReady: true });
  const saved = await readLeadSessions(A, f.platform);
  assert.equal(new Set(Object.values(saved.sessions)).size, 3);
  await prepareLeadSessions(A, input, f.platform);
  assert.equal(f.sessions.size, 3);
  assert.deepEqual(f.calls.slice(3).map(call => call.expectedSessionId), Object.values(saved.sessions));
  assert.ok(f.calls.every(call => call.companyId === A && call.agentId === AGENT));
  assert.equal(f.states.has(`${A}:snapshot.v1`), false);
});

test("partial creation and lost response recover by the same owned key, not a replacement request", async () => {
  const f = fixture();
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  const ensure = f.platform.agents.sessions.ensure;
  let loseResponse = true;
  f.platform.agents.sessions.ensure = async (...args) => {
    const result = await ensure(...args);
    if (loseResponse && args[2].taskKey.endsWith(":cto-inbox")) { loseResponse = false; throw new Error("Response lost after commit"); }
    return result;
  };
  await assert.rejects(prepareLeadSessions(A, input, f.platform), /Response lost/);
  const partial = await readLeadSessions(A, f.platform);
  assert.ok(partial.sessions.main);
  assert.equal(partial.sessions["cto-inbox"], null);
  assert.equal(f.sessions.size, 2);
  await prepareLeadSessions(A, input, f.platform);
  assert.equal(f.sessions.size, 3);
  assert.equal((await readLeadSessions(A, f.platform)).sessions.main, partial.sessions.main);
});

test("failed state save retains uncertainty and retry finds the same committed session", async () => {
  const f = fixture();
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  const save = f.platform.state.set;
  let fail = true;
  f.platform.state.set = async (...args) => { if (fail) { fail = false; throw new Error("Save failed"); } return save(...args); };
  await assert.rejects(prepareLeadSessions(A, input, f.platform), /Save failed/);
  assert.equal(f.sessions.size, 1);
  await prepareLeadSessions(A, input, f.platform);
  assert.equal(f.sessions.size, 3);
});

test("known deleted session fails without recreating or advancing other channels", async () => {
  const f = fixture();
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  await prepareLeadSessions(A, input, f.platform);
  const saved = structuredClone(await readLeadSessions(A, f.platform));
  f.sessions.delete(JSON.stringify([A, AGENT, f.calls[0].taskKey]));
  await assert.rejects(prepareLeadSessions(A, input, f.platform), /Expected session unavailable/);
  assert.equal(f.sessions.size, 2);
  assert.deepEqual(await readLeadSessions(A, f.platform), saved);
});

test("selection history and Workspace bindings stay separate without closing prior sessions", async () => {
  const f = fixture();
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  await prepareLeadSessions(A, input, f.platform);
  const original = await readLeadSessions(A, f.platform);
  await selectLeadAgent(A, { agentId: OTHER, expectedRevision: 1 }, f.platform);
  assert.deepEqual((await readLeadSessions(A, f.platform)).sessions, { main: null, "cto-inbox": null, decisions: null });
  await assert.rejects(prepareLeadSessions(A, input, f.platform), /selection changed/);
  await prepareLeadSessions(A, { agentId: OTHER, expectedRevision: 2 }, f.platform);
  await selectLeadAgent(B, { agentId: AGENT, expectedRevision: 0 }, f.platform);
  await prepareLeadSessions(B, input, f.platform);
  assert.equal(f.sessions.size, 9);
  assert.deepEqual((f.states.get(`${A}:lead-sessions.v1.1`) as unknown as typeof original).sessions, original.sessions);
});

test("parallel preparations serialize and cannot create six sessions", async () => {
  const f = fixture();
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  await Promise.all([prepareLeadSessions(A, input, f.platform), prepareLeadSessions(A, input, f.platform)]);
  assert.equal(f.sessions.size, 3);
  assert.equal(f.calls.length, 6);
});

test("invalid Host results, corrupt records, stale selection and unsupported Hosts fail closed", async () => {
  const f = fixture();
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  const ensure = f.platform.agents.sessions.ensure;
  for (const result of [null, { sessionId: "bad", created: true }, { sessionId: AGENT, created: true, extra: true }]) {
    f.platform.agents.sessions.ensure = async () => result as never;
    await assert.rejects(prepareLeadSessions(A, input, f.platform), /Invalid Host/);
  }
  f.platform.agents.sessions.ensure = async () => { throw new Error("Method not found"); };
  await assert.rejects(prepareLeadSessions(A, input, f.platform), /Method not found/);
  f.platform.agents.sessions.ensure = ensure;
  f.states.set(`${A}:lead-sessions.v1.1`, { workspaceId: B } as JsonValue);
  await assert.rejects(readLeadSessions(A, f.platform));
  assert.equal(f.sessions.size, 0);
  for (const params of [{ ...input, expectedRevision: 0 }, { ...input, extra: true }, { ...input, agentId: null }]) {
    await assert.rejects(prepareLeadSessions(A, params, f.platform));
  }
});

test("session records reject duplicate IDs, unknown fields and cross-Workspace data", () => {
  const value = { workspaceId: A, agentId: AGENT, selectionRevision: 1,
    sessions: { main: AGENT, "cto-inbox": OTHER, decisions: null } };
  assert.deepEqual(parseLeadSessions(value, A), value);
  for (const invalid of [{ ...value, workspaceId: B }, { ...value, secret: "x" },
    { ...value, sessions: { ...value.sessions, decisions: AGENT.toUpperCase() } },
    { ...value, sessions: { ...value.sessions, extra: null } }, { ...value, agentId: null }]) {
    assert.throws(() => parseLeadSessions(invalid, A));
  }
});

test("unexpected selection change during an awaited ensure cannot publish a replacement binding", async () => {
  const f = fixture();
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  const ensure = f.platform.agents.sessions.ensure;
  f.platform.agents.sessions.ensure = async (...args) => {
    const result = await ensure(...args);
    f.states.set(`${A}:lead-agent.v1`, { workspaceId: A, revision: 2, selectedAgentId: OTHER });
    return result;
  };
  await assert.rejects(prepareLeadSessions(A, input, f.platform), /selection changed/);
  assert.equal(f.sessions.size, 1);
  assert.equal(f.states.has(`${A}:lead-sessions.v1.1`), false);
  assert.equal((await readLeadSessions(A, f.platform)).agentId, OTHER);
});

test("invalid duplicate IDs and contradictory known-ID creation cannot overwrite saved channels", async () => {
  const f = fixture();
  await selectLeadAgent(A, { ...input, expectedRevision: 0 }, f.platform);
  f.platform.agents.sessions.ensure = async () => ({ sessionId: OTHER, created: true });
  await assert.rejects(prepareLeadSessions(A, input, f.platform), /duplicate Lead session/);
  const partial = await readLeadSessions(A, f.platform);
  assert.equal(partial.sessions.main, OTHER);
  assert.equal(partial.sessions["cto-inbox"], null);
  await assert.rejects(prepareLeadSessions(A, input, f.platform), /Invalid Host/);
  assert.deepEqual(await readLeadSessions(A, f.platform), partial);
});

test("preparation action requires authenticated same-Workspace user metadata before reading", async () => {
  const f = fixture();
  const action = createBuilderPlatform().actions.find(action => action.key === "builder.prepare-lead-sessions")!;
  let reads = 0;
  f.platform.state.get = async () => { reads++; return null; };
  for (const actor of [{ type: "agent", companyId: A }, { type: "user", companyId: B }] as const) {
    await assert.rejects(Promise.resolve().then(() => action.handler(input, { ...f.platform, companyId: A, actor })));
  }
  await assert.rejects(Promise.resolve().then(() => action.handler({ ...input, companyId: B },
    { ...f.platform, companyId: A, actor: { type: "user", companyId: A } })));
  assert.equal(reads, 0);
});
