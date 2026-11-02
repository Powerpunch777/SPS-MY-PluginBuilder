import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createProjectCto, listProjectCtos, readProjectCtos } from "../src/project-cto-tools.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const OTHER_LEAD = "44444444-4444-4444-8444-444444444444";
const MAIN = "55555555-5555-4555-8555-555555555555";
const INBOX = "66666666-6666-4666-8666-666666666666";
const DECISIONS = "77777777-7777-4777-8777-777777777777";
const RUN = "88888888-8888-4888-8888-888888888888";
const PROJECT = "project-alpha";
const NAMESPACE = "sonpark.my-builder";
const SESSION_TASK_PREFIX = "plugin:com.sonparkserver.my-plugin-builder:session:";
type Expected = { exists: false } | { exists: true; value: JsonValue };
const fullKey = (key: SpsStateKey) => JSON.stringify([key.scopeKind, key.scopeId, key.namespace, key.stateKey]);

function fixture() {
  const values = new Map<string, JsonValue>();
  const sessions = new Map<string, string>();
  const casCalls: Array<{ key: SpsStateKey; expected: Expected; value: JsonValue }> = [];
  const ensureCalls: Array<{ agentId: string; companyId: string; taskKey: string; expectedSessionId?: string }> = [];
  let setCalls = 0;
  let createdSessions = 0;
  let nextSession = 0;
  const key = (workspaceId: string, stateKey: string): SpsStateKey => ({
    scopeKind: "company", scopeId: workspaceId, namespace: NAMESPACE, stateKey,
  });
  function seedLead(workspaceId: string, agentId = LEAD) {
    values.set(fullKey(key(workspaceId, "lead-agent.v1")), {
      workspaceId, revision: 1, selectedAgentId: agentId,
    });
    values.set(fullKey(key(workspaceId, "lead-sessions.v1.1")), {
      workspaceId, selectionRevision: 1, agentId,
      sessions: { main: MAIN, "cto-inbox": INBOX, decisions: DECISIONS },
    });
  }
  seedLead(WORKSPACE);
  const state = {
    async get(input: SpsStateKey) { return structuredClone(values.get(fullKey(input)) ?? null); },
    async set() { setCalls += 1; throw new Error("Project CTO tools must not call state.set"); },
    async compareAndSet(input: SpsStateKey, expected: Expected, value: JsonValue) {
      casCalls.push({ key: structuredClone(input), expected: structuredClone(expected), value: structuredClone(value) });
      const id = fullKey(input);
      const exists = values.has(id);
      const current = values.get(id);
      const swapped = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (swapped) values.set(id, structuredClone(value));
      return { swapped };
    },
  };
  const platform = {
    state,
    agents: {
      async list({ companyId }: { companyId: string }) {
        return [{ id: LEAD, companyId, name: "Lead", status: "idle", config: { unchanged: true } }];
      },
      sessions: {
        async ensure(agentId: string, companyId: string, options: { taskKey: string; expectedSessionId?: string }) {
          ensureCalls.push({ agentId, companyId, ...options });
          if (!options.taskKey.startsWith(SESSION_TASK_PREFIX)) throw new Error("Host session taskKey must be plugin-owned");
          const sessionKey = JSON.stringify([companyId, agentId, options.taskKey]);
          const known = sessions.get(sessionKey);
          if (options.expectedSessionId !== undefined && options.expectedSessionId !== known) {
            throw new Error("Expected session unavailable");
          }
          if (known) return { sessionId: known, created: false };
          const id = `${String(++nextSession).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
          sessions.set(sessionKey, id);
          createdSessions += 1;
          return { sessionId: id, created: true };
        },
        async create() { throw new Error("No session create fallback"); },
        async list() { throw new Error("No session list fallback"); },
        async sendMessage() { throw new Error("Project CTO registration must not execute AI"); },
      },
    },
  } as unknown as SpsPlatformInvocationContext;
  const context = (workspaceId = WORKSPACE, agentId = LEAD, sessionId = MAIN) => ({
    companyId: workspaceId, agentId, runId: RUN, sessionId,
  });
  return {
    values, sessions, casCalls, ensureCalls, platform, state, key, context, seedLead,
    get setCalls() { return setCalls; },
    get createdSessions() { return createdSessions; },
  };
}

const ctoParams = (ctoId: string, displayName = `Name ${ctoId}`, projectId = PROJECT) => ({ projectId, ctoId, displayName });
const registration = (result: unknown) => (result as { data: { status: string; executionStarted: boolean; cto: { ctoId: string; sessionId: string } } }).data;

test("registers one project-local session per CTO and repeats by the exact keyed identity", async () => {
  const f = fixture();
  const first = registration(await createProjectCto(ctoParams("cto-one"), f.context(), f.platform));
  const second = registration(await createProjectCto(ctoParams("cto-two"), f.context(), f.platform));
  const repeated = registration(await createProjectCto(ctoParams("cto-one"), f.context(), f.platform));
  assert.equal(first.cto.sessionId, "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(second.cto.sessionId, "00000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.deepEqual(repeated.cto, first.cto);
  assert.equal(f.createdSessions, 2);
  assert.equal(f.sessions.size, 2);
  assert.ok([MAIN, INBOX, DECISIONS].every(id => id !== first.cto.sessionId && id !== second.cto.sessionId));
  assert.ok(f.ensureCalls.every(call => call.agentId === LEAD && call.companyId === WORKSPACE));
  assert.ok(f.ensureCalls.every(call => call.taskKey.startsWith(`${SESSION_TASK_PREFIX}cto:`)));
  assert.equal(f.ensureCalls[2]?.expectedSessionId, first.cto.sessionId);
  const listed = await listProjectCtos({ projectId: PROJECT }, f.context(), f.platform);
  assert.equal((listed.data as { ctos: unknown[] }).ctos.length, 2);
  assert.equal(f.setCalls, 0);
  assert.ok(f.casCalls.length >= 4);
});

test("same project and CTO names remain isolated by Workspace and project", async () => {
  const f = fixture();
  f.seedLead(OTHER_WORKSPACE);
  await createProjectCto(ctoParams("same-cto"), f.context(), f.platform);
  await createProjectCto(ctoParams("same-cto"), f.context(OTHER_WORKSPACE), f.platform);
  await createProjectCto(ctoParams("same-cto", "Other project CTO", "project-beta"), f.context(), f.platform);
  const first = await readProjectCtos(WORKSPACE, PROJECT, f.platform);
  const otherWorkspace = await readProjectCtos(OTHER_WORKSPACE, PROJECT, f.platform);
  const otherProject = await readProjectCtos(WORKSPACE, "project-beta", f.platform);
  assert.equal(first.ctos.length, 1);
  assert.equal(otherWorkspace.ctos.length, 1);
  assert.equal(otherProject.ctos.length, 1);
  assert.notEqual(first.ctos[0]?.sessionId, otherWorkspace.ctos[0]?.sessionId);
  assert.notEqual(first.ctos[0]?.sessionId, otherProject.ctos[0]?.sessionId);
  assert.equal(f.createdSessions, 3);
});

test("lost ensure response recovers the committed keyed session on explicit retry", async () => {
  const f = fixture();
  const ensure = f.platform.agents.sessions.ensure;
  let lose = true;
  f.platform.agents.sessions.ensure = async (...args) => {
    const result = await ensure(...args);
    if (lose) { lose = false; throw new Error("ensure response lost after Core commit"); }
    return result;
  };
  await assert.rejects(createProjectCto(ctoParams("lost-ensure"), f.context(), f.platform), /response lost/);
  const reserved = await readProjectCtos(WORKSPACE, PROJECT, f.platform);
  assert.equal(reserved.ctos[0]?.sessionId, null);
  const recovered = registration(await createProjectCto(ctoParams("lost-ensure"), f.context(), f.platform));
  assert.equal(recovered.cto.sessionId, "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(f.createdSessions, 1);
  assert.equal(f.ensureCalls[1]?.taskKey, f.ensureCalls[0]?.taskKey);
  assert.equal(f.ensureCalls[1]?.expectedSessionId, undefined);
});

test("lost final CAS response is recovered by a deliberate retry and read", async () => {
  const f = fixture();
  const compareAndSet = f.state.compareAndSet.bind(f.state);
  let lose = true;
  f.state.compareAndSet = async (...args) => {
    const receipt = await compareAndSet(...args);
    if (lose && receipt.swapped && (args[2] as { ctos?: Array<{ sessionId: string | null }> }).ctos?.[0]?.sessionId) {
      lose = false;
      throw new Error("final CAS response lost after commit");
    }
    return receipt;
  };
  await assert.rejects(createProjectCto(ctoParams("lost-final-cas"), f.context(), f.platform), /response lost/);
  const visible = await readProjectCtos(WORKSPACE, PROJECT, f.platform);
  assert.equal(visible.ctos[0]?.sessionId, "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const retry = registration(await createProjectCto(ctoParams("lost-final-cas"), f.context(), f.platform));
  assert.deepEqual(retry.cto, visible.ctos[0]);
  assert.equal(f.createdSessions, 1);
});

test("stale reservation or final CAS returns conflict without set or fallback", async () => {
  const reservation = fixture();
  reservation.state.compareAndSet = async () => ({ swapped: false });
  const lostReservation = await createProjectCto(ctoParams("stale-reservation"), reservation.context(), reservation.platform);
  assert.equal((lostReservation.data as { status: string }).status, "conflict");
  assert.equal(reservation.ensureCalls.length, 0);
  assert.equal(reservation.createdSessions, 0);
  assert.equal(reservation.setCalls, 0);

  const final = fixture();
  const cas = final.state.compareAndSet.bind(final.state);
  final.state.compareAndSet = async (...args) => {
    if ((args[2] as { ctos?: Array<{ sessionId: string | null }> }).ctos?.[0]?.sessionId) return { swapped: false };
    return cas(...args);
  };
  const lostFinal = await createProjectCto(ctoParams("stale-final"), final.context(), final.platform);
  assert.equal((lostFinal.data as { status: string }).status, "conflict");
  assert.equal(final.createdSessions, 1);
  assert.equal(final.setCalls, 0);
  assert.equal(final.ensureCalls.length, 1);
  assert.equal(final.sessions.size, 1);
});

test("wrong Lead or unprepared Lead session fails before keyed ensure", async () => {
  const f = fixture();
  await assert.rejects(createProjectCto(ctoParams("wrong-agent"), f.context(WORKSPACE, OTHER_LEAD), f.platform), /current Builder Lead/);
  await assert.rejects(createProjectCto(ctoParams("wrong-session"), f.context(WORKSPACE, LEAD, "99999999-9999-4999-8999-999999999999"), f.platform), /prepared current Lead session/);
  assert.equal(f.ensureCalls.length, 0);
  assert.equal(f.casCalls.length, 0);
  assert.equal(f.createdSessions, 0);
});

test("malformed Host identity and corrupt registry fail closed", async () => {
  const malformed = fixture();
  malformed.platform.agents.sessions.ensure = async () => ({ sessionId: "bad-id", created: true });
  await assert.rejects(createProjectCto(ctoParams("bad-host"), malformed.context(), malformed.platform), /Invalid Host CTO session identity/);
  assert.equal(malformed.sessions.size, 0);
  assert.equal(malformed.setCalls, 0);

  const corrupt = fixture();
  await createProjectCto(ctoParams("corrupt-key-discovery"), corrupt.context(), corrupt.platform);
  const actualKey = corrupt.casCalls[0]!.key;
  corrupt.values.set(fullKey(actualKey), { schemaVersion: 1, workspaceId: OTHER_WORKSPACE, projectId: PROJECT, revision: 1, ctos: [] } as unknown as JsonValue);
  await assert.rejects(readProjectCtos(WORKSPACE, PROJECT, corrupt.platform), /cross-workspace\/project/);
  await assert.rejects(listProjectCtos({ projectId: PROJECT }, corrupt.context(), corrupt.platform), /cross-workspace\/project/);
  assert.equal(corrupt.ensureCalls.length, 1);
  assert.equal(corrupt.setCalls, 0);
});

test("a removed known session fails closed without creating a replacement", async () => {
  const f = fixture();
  const created = registration(await createProjectCto(ctoParams("removed"), f.context(), f.platform));
  const sessionKey = JSON.stringify([WORKSPACE, LEAD, f.ensureCalls[0]!.taskKey]);
  f.sessions.delete(sessionKey);
  await assert.rejects(createProjectCto(ctoParams("removed"), f.context(), f.platform), /Expected session unavailable/);
  assert.equal(f.createdSessions, 1);
  assert.equal(f.sessions.size, 0);
  assert.equal(f.ensureCalls[1]?.expectedSessionId, created.cto.sessionId);
  assert.equal((await readProjectCtos(WORKSPACE, PROJECT, f.platform)).ctos[0]?.sessionId, created.cto.sessionId);
  assert.equal(f.setCalls, 0);
});

test("a registered CTO session cannot impersonate the current Lead even with the same execution Agent", async () => {
  const f = fixture();
  const created = registration(await createProjectCto(ctoParams("cto"), f.context(), f.platform));
  const before = f.ensureCalls.length;
  const ctoContext = f.context(WORKSPACE, LEAD, created.cto.sessionId);
  await assert.rejects(createProjectCto(ctoParams("nested"), ctoContext, f.platform), /prepared current Lead session/);
  await assert.rejects(listProjectCtos({ projectId: PROJECT }, ctoContext, f.platform), /prepared current Lead session/);
  assert.equal(f.ensureCalls.length, before);
});

test("concurrent independent creators cannot overwrite a registry or duplicate a session", async () => {
  const f = fixture();
  const outcomes = await Promise.all(["first", "second"].map(id => createProjectCto(ctoParams(id), f.context(), f.platform)));
  assert.equal(outcomes.filter(result => (result.data as { status: string }).status === "registered").length, 1);
  assert.equal(outcomes.filter(result => (result.data as { status: string }).status === "conflict").length, 1);
  assert.equal((await readProjectCtos(WORKSPACE, PROJECT, f.platform)).ctos.length, 1);
  assert.equal(f.createdSessions, 1);
  assert.equal(f.setCalls, 0);
});

test("Lead handoff preserves the CTO runtime and identity without handing over its private memory", async () => {
  const f = fixture();
  const before = registration(await createProjectCto(ctoParams("retained"), f.context(), f.platform));
  f.seedLead(WORKSPACE, OTHER_LEAD);
  await assert.rejects(createProjectCto(ctoParams("retained"), f.context(), f.platform), /current Builder Lead/);
  const after = registration(await createProjectCto(ctoParams("retained"), f.context(WORKSPACE, OTHER_LEAD), f.platform));
  assert.deepEqual(after.cto, before.cto);
  assert.equal(f.createdSessions, 1);
  assert.equal(f.ensureCalls.at(-1)?.agentId, LEAD);
  assert.equal(f.ensureCalls.at(-1)?.expectedSessionId, before.cto.sessionId);
  assert.equal(Object.hasOwn(after.cto, "memory"), false);
});

test("rename, retired identity, missing CAS and borrowed Lead session never become replacement execution", async () => {
  const f = fixture();
  await createProjectCto(ctoParams("stable"), f.context(), f.platform);
  await assert.rejects(createProjectCto(ctoParams("stable", "different"), f.context(), f.platform), /different or retired/);
  const key = f.casCalls[0]!.key;
  const raw = structuredClone(f.values.get(fullKey(key))) as { ctos: Array<{ status: string }> };
  raw.ctos[0]!.status = "RETIRED";
  f.values.set(fullKey(key), raw as JsonValue);
  await assert.rejects(createProjectCto(ctoParams("stable"), f.context(), f.platform), /different or retired/);
  assert.equal(f.createdSessions, 1);
  const unsupported = fixture();
  const noCas = { ...unsupported.platform, state: { ...unsupported.state, compareAndSet: undefined } } as unknown as SpsPlatformInvocationContext;
  await assert.rejects(createProjectCto(ctoParams("unsupported"), unsupported.context(), noCas), /CAS and keyed session ensure/);
  assert.equal(unsupported.ensureCalls.length, 0);
  const borrowed = fixture();
  borrowed.platform.agents.sessions.ensure = async () => ({ sessionId: MAIN, created: false });
  await assert.rejects(createProjectCto(ctoParams("borrowed"), borrowed.context(), borrowed.platform), /Invalid Host CTO session identity/);
  assert.equal((await readProjectCtos(WORKSPACE, PROJECT, borrowed.platform)).ctos[0]?.sessionId, null);
});
