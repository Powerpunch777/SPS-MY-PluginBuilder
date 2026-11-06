import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsActionContext, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createBuilderPlatform, selectLeadAgent } from "../src/platform.ts";
import { integrationManagerSessionStateKey, integrationManagerSessionTaskKey, integrationManagerStateKey } from "../src/domain/integration-manager.ts";
import { readIntegrationManagerOptions, selectIntegrationManager } from "../src/integration-manager-settings.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const MANAGER = "33333333-3333-4333-8333-333333333333";
const NEXT_MANAGER = "55555555-5555-4555-8555-555555555555";
const SESSION = "44444444-4444-4444-8444-444444444444";
const keyId = (key: SpsStateKey) => `${key.scopeId}:${key.stateKey}`;

function fixture() {
  const states = new Map<string, JsonValue>();
  const writes: string[] = [];
  const counters = { lists: 0, ensures: 0, owned: 0 };
  const agents = [
    { id: LEAD, companyId: WORKSPACE, name: "Main", status: "idle", adapterConfig: { token: "secret" } },
    { id: MANAGER, companyId: WORKSPACE, name: "Integration Manager", status: "paused", adapterConfig: { cwd: "private" } },
  ];
  const state = {
    async get(key: SpsStateKey) { return structuredClone(states.get(keyId(key)) ?? null); },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, next: JsonValue) {
      const id = keyId(key), exists = states.has(id), current = states.get(id);
      const swapped = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
      if (swapped) { states.set(id, structuredClone(next)); writes.push(key.stateKey); }
      return { swapped };
    },
    async set() { throw new Error("state.set must not be used by Manager selection"); },
  };
  const platform = {
    companyId: WORKSPACE,
    actor: { type: "user", userId: "authenticated-user", companyId: WORKSPACE },
    state,
    agents: {
      async list(input: { companyId: string; limit: number }) {
        assert.deepEqual(input, { companyId: WORKSPACE, limit: 100 });
        counters.lists += 1;
        return structuredClone(agents);
      },
      async describeExecution() { throw new Error("This slice must not claim execution readiness"); },
      sessions: {
        async ensure(agentId: string, companyId: string, options: { taskKey: string; expectedSessionId?: string }) {
          counters.ensures += 1;
          assert.equal(agentId, MANAGER);
          assert.equal(companyId, WORKSPACE);
          assert.match(options.taskKey, /^plugin:com\.sonparkserver\.my-plugin-builder:session:integration-manager:/u);
          return { sessionId: options.expectedSessionId ?? SESSION, created: options.expectedSessionId === undefined };
        },
      },
    },
  } as unknown as SpsActionContext & SpsPlatformInvocationContext;
  return { states, writes, counters, agents, state, platform };
}

test("registered Manager data returns exact safe DTO and performs reads only", async () => {
  const f = fixture();
  const route = createBuilderPlatform().data.find(item => item.key === "builder.integration-manager");
  assert.ok(route);
  const value = await route.handler({ companyId: WORKSPACE, renderEnvironment: null }, f.platform);
  assert.deepEqual(value, { workspaceId: WORKSPACE, revision: 0, selectedAgentId: null,
    agents: [{ id: LEAD, name: "Main", status: "idle" }, { id: MANAGER, name: "Integration Manager", status: "paused" }],
    sessionId: null, executionReadiness: "unknown", aiRunStarted: false });
  assert.deepEqual(f.writes, []);
  assert.equal(f.counters.ensures, 0);
  assert.equal(f.counters.owned, 0);
  assert.equal(JSON.stringify(value).includes("secret"), false);
  assert.equal(JSON.stringify(value).includes("private"), false);
});

test("selection enforces user scope, exact revision, Lead exclusion, membership, and CAS only", async () => {
  const f = fixture();
  f.states.set(`${WORKSPACE}:lead-agent.v1`, { workspaceId: WORKSPACE, revision: 4, selectedAgentId: LEAD });
  assert.deepEqual(await selectIntegrationManager(WORKSPACE, { agentId: MANAGER, expectedRevision: 0 }, f.platform),
    { saved: true, executionStarted: false, revision: 1 });
  assert.deepEqual(f.states.get(keyId(integrationManagerStateKey(WORKSPACE))), {
    schemaVersion: 1, workspaceId: WORKSPACE, revision: 1, selectedAgentId: MANAGER,
  });
  await assert.rejects(selectIntegrationManager(WORKSPACE, { agentId: LEAD, expectedRevision: 1 }, f.platform), /Lead Agent/);
  await assert.rejects(selectIntegrationManager(WORKSPACE, { agentId: LEAD, expectedRevision: 0 }, f.platform), /changed/);
  await assert.rejects(selectIntegrationManager(WORKSPACE, { agentId: "55555555-5555-4555-8555-555555555555", expectedRevision: 1 }, f.platform), /available Agent/);
  await assert.deepEqual(await selectIntegrationManager(WORKSPACE, { agentId: null, expectedRevision: 1 }, f.platform),
    { saved: true, executionStarted: false, revision: 2 });
  const paused = f.states.get(keyId(integrationManagerStateKey(WORKSPACE))) as Record<string, JsonValue>;
  assert.equal(paused.selectedAgentId, null);
  assert.equal(paused.revision, 2);
  assert.deepEqual(f.writes, ["integration-manager-agent.v1", "integration-manager-agent.v1"]);

  const explicitPause = fixture();
  assert.deepEqual(await selectIntegrationManager(WORKSPACE, { agentId: null, expectedRevision: 0 }, explicitPause.platform),
    { saved: true, executionStarted: false, revision: 1 });
  assert.deepEqual(explicitPause.states.get(keyId(integrationManagerStateKey(WORKSPACE))), {
    schemaVersion: 1, workspaceId: WORKSPACE, revision: 1, selectedAgentId: null,
  });
  for (const status of ["paused", "idle", "running"]) {
    const selectable = fixture();
    selectable.agents[1]!.status = status;
    assert.deepEqual(await selectIntegrationManager(WORKSPACE, { agentId: MANAGER, expectedRevision: 0 }, selectable.platform),
      { saved: true, executionStarted: false, revision: 1 });
  }

  const noCas = fixture();
  delete (noCas.platform.state as unknown as { compareAndSet?: unknown }).compareAndSet;
  await assert.rejects(selectIntegrationManager(WORKSPACE, { agentId: MANAGER, expectedRevision: 0 }, noCas.platform), /Unsupported Host.*compareAndSet/);
  assert.deepEqual(noCas.writes, []);

  const contention = fixture();
  contention.state.compareAndSet = async () => ({ swapped: false });
  await assert.rejects(selectIntegrationManager(WORKSPACE, { agentId: MANAGER, expectedRevision: 0 }, contention.platform), /changed\. Refresh/);
  assert.deepEqual(contention.writes, []);

  const malformed = fixture();
  malformed.state.compareAndSet = async () => Object.defineProperty({}, "swapped", {
    enumerable: true, get() { throw new Error("receipt getter must not execute"); },
  }) as { swapped: boolean };
  await assert.rejects(selectIntegrationManager(WORKSPACE, { agentId: MANAGER, expectedRevision: 0 }, malformed.platform), /Invalid Host.*receipt/);
  assert.deepEqual(malformed.writes, []);
});

test("selection rejects unauthenticated, cross-Workspace, nonselectable and malformed requests", async () => {
  const f = fixture();
  const route = createBuilderPlatform().actions.find(item => item.key === "builder.select-integration-manager");
  assert.ok(route);
  for (const context of [
    { ...f.platform, actor: { type: "agent", companyId: WORKSPACE } },
    { ...f.platform, actor: { type: "user", userId: "u", companyId: "99999999-9999-4999-8999-999999999999" } },
    { ...f.platform, actor: { type: "user", companyId: WORKSPACE } },
  ]) await assert.rejects(() => Promise.resolve().then(() => route.handler({ agentId: MANAGER, expectedRevision: 0 }, context as SpsActionContext)));
  await assert.rejects(() => Promise.resolve().then(() => route.handler({ agentId: MANAGER, expectedRevision: 0, extra: true }, f.platform)));
  await assert.rejects(() => Promise.resolve().then(() => route.handler({ agentId: MANAGER, expectedRevision: -1 }, f.platform)));
  f.agents[1]!.status = "failed";
  await assert.rejects(selectIntegrationManager(WORKSPACE, { agentId: MANAGER, expectedRevision: 0 }, f.platform), /available Agent/);
  assert.deepEqual(f.writes, []);
});

test("prepare route ensures only an existing selected Manager session and persists its scoped binding", async () => {
  const f = fixture();
  f.states.set(keyId(integrationManagerStateKey(WORKSPACE)), {
    schemaVersion: 1, workspaceId: WORKSPACE, revision: 1, selectedAgentId: MANAGER,
  });
  const route = createBuilderPlatform().actions.find(item => item.key === "builder.prepare-integration-manager");
  assert.ok(route);
  const result = await route.handler({ projectId: WORKSPACE, expectedManagerRevision: 1 }, f.platform);
  assert.equal((result as { status: string }).status, "preserved");
  assert.equal((result as { managerSessionId: string }).managerSessionId, SESSION);
  assert.equal((result as { executionReadiness: string }).executionReadiness, "unknown");
  assert.equal((result as { aiRunStarted: boolean }).aiRunStarted, false);
  assert.equal(f.counters.ensures, 1);
  assert.equal(f.counters.owned, 0);
  assert.deepEqual(f.states.get(keyId(integrationManagerSessionStateKey(WORKSPACE, WORKSPACE, MANAGER))), {
    schemaVersion: 1, workspaceId: WORKSPACE, projectId: WORKSPACE, managerAgentId: MANAGER, sessionId: SESSION,
    taskKey: integrationManagerSessionTaskKey(WORKSPACE, WORKSPACE, MANAGER),
  });
  assert.deepEqual(f.writes, [integrationManagerSessionStateKey(WORKSPACE, WORKSPACE, MANAGER).stateKey]);
  const data = createBuilderPlatform().data.find(item => item.key === "builder.integration-manager");
  assert.ok(data);
  assert.equal((await data.handler({ companyId: WORKSPACE }, f.platform) as { sessionId: string }).sessionId, SESSION);
});

test("Lead selection rejects the currently selected Integration Manager Agent", async () => {
  const f = fixture();
  f.agents[1]!.status = "idle";
  f.states.set(keyId(integrationManagerStateKey(WORKSPACE)), {
    schemaVersion: 1, workspaceId: WORKSPACE, revision: 1, selectedAgentId: MANAGER,
  });
  await assert.rejects(() => selectLeadAgent(WORKSPACE, { agentId: MANAGER, expectedRevision: 0 }, f.platform), /Integration Manager/);
  assert.deepEqual(f.writes, []);
});

test("switching Managers preserves the previous Agent session and never presents it as the new session", async () => {
  const f = fixture();
  f.agents.push({ id: NEXT_MANAGER, companyId: WORKSPACE, name: "Next Manager", status: "paused", adapterConfig: { token: "hidden" } });
  const oldSessionKey = integrationManagerSessionStateKey(WORKSPACE, WORKSPACE, MANAGER);
  const oldSession = { schemaVersion: 1, workspaceId: WORKSPACE, projectId: WORKSPACE, managerAgentId: MANAGER, sessionId: SESSION,
    taskKey: integrationManagerSessionTaskKey(WORKSPACE, WORKSPACE, MANAGER) } as unknown as JsonValue;
  f.states.set(keyId(integrationManagerStateKey(WORKSPACE)), {
    schemaVersion: 1, workspaceId: WORKSPACE, revision: 1, selectedAgentId: MANAGER,
  });
  f.states.set(keyId(oldSessionKey), oldSession);
  await selectIntegrationManager(WORKSPACE, { agentId: NEXT_MANAGER, expectedRevision: 1 }, f.platform);
  assert.deepEqual(f.states.get(keyId(oldSessionKey)), oldSession);
  const options = await readIntegrationManagerOptions(WORKSPACE, f.platform);
  assert.equal(options.selectedAgentId, NEXT_MANAGER);
  assert.equal(options.sessionId, null);
});

test("default profile preparation remains UNKNOWN when pinned public SDK lacks owned-agent operations", async () => {
  const f = fixture();
  const route = createBuilderPlatform().actions.find(item => item.key === "builder.prepare-integration-manager");
  assert.ok(route);
  const result = await route.handler({ projectId: WORKSPACE, expectedManagerRevision: 0 }, f.platform) as { status: string; reason: string };
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "host-owned-agent-api-or-agents-owned-manage-unavailable");
  assert.equal(f.counters.ensures, 0);
  assert.deepEqual(f.writes, []);
});

test("only a runtime Host exposing both owned get and ensure is delegated profile provisioning", async () => {
  const f = fixture();
  f.states.set(`${WORKSPACE}:lead-agent.v1`, { workspaceId: WORKSPACE, revision: 4, selectedAgentId: LEAD });
  f.platform.agents.describeExecution = async () => ({ agentId: LEAD, adapterType: "codex_local", state: "configured",
    adapterRegistration: "registered", executionOwner: "adapter", authorization: "recheck_on_dispatch",
    readiness: "unknown", node: null });
  const owned = {
    async get(input: { companyId: string; pluginAgentKey: string }) {
      f.counters.owned += 1;
      assert.deepEqual(input, { companyId: WORKSPACE, pluginAgentKey: "integration-manager" });
      return { status: "missing" };
    },
    async ensure(input: { companyId: string; pluginAgentKey: string; config: { name: string; role: string; instructions: string } }) {
      f.counters.owned += 1;
      assert.equal(input.companyId, WORKSPACE);
      assert.equal(input.pluginAgentKey, "integration-manager");
      return { status: "created", revision: 1, agent: { agentId: MANAGER, name: input.config.name,
        role: input.config.role, title: null, icon: null, capabilities: null, adapterType: "neutral", status: "paused",
        instructions: input.config.instructions, executionDefaults: {} } };
    },
  };
  Object.assign(f.platform.agents, { owned });
  const route = createBuilderPlatform().actions.find(item => item.key === "builder.prepare-integration-manager");
  assert.ok(route);
  const result = await route.handler({ projectId: WORKSPACE, expectedManagerRevision: 0 }, f.platform) as { status: string; managerAgentId: string };
  assert.equal(result.status, "provisioned");
  assert.equal(result.managerAgentId, MANAGER);
  assert.equal(f.counters.owned, 2);
  assert.deepEqual(f.states.get(keyId(integrationManagerStateKey(WORKSPACE))), {
    schemaVersion: 1, workspaceId: WORKSPACE, revision: 1, selectedAgentId: MANAGER,
  });
});

test("default Manager binding and concurrent Lead assignment share one Workspace lane", async () => {
  const f = fixture();
  f.agents[1]!.status = "idle";
  f.states.set(`${WORKSPACE}:lead-agent.v1`, { workspaceId: WORKSPACE, revision: 4, selectedAgentId: LEAD });
  let enteredGet!: () => void;
  let releaseGet!: () => void;
  const getEntered = new Promise<void>(resolve => { enteredGet = resolve; });
  const getRelease = new Promise<void>(resolve => { releaseGet = resolve; });
  const profile = { agentId: MANAGER, name: "Integration Manager", role: "integration-manager", title: null, icon: null,
    capabilities: null, adapterType: "neutral", status: "idle", instructions: "Preserve existing profile", executionDefaults: {} };
  Object.assign(f.platform.agents, { owned: {
    async get() { enteredGet(); await getRelease; return { status: "resolved", revision: 3, agent: profile }; },
    async ensure() { throw new Error("Existing owned profile must not be reconfigured"); },
  } });
  const contract = createBuilderPlatform();
  const prepare = contract.actions.find(item => item.key === "builder.prepare-integration-manager");
  const selectLead = contract.actions.find(item => item.key === "builder.select-lead-agent");
  assert.ok(prepare && selectLead);
  const prepareResult = prepare.handler({ projectId: WORKSPACE, expectedManagerRevision: 0 }, f.platform);
  await getEntered;
  const leadResult = selectLead.handler({ agentId: MANAGER, expectedRevision: 4 }, f.platform);
  const leadRejected = assert.rejects(() => Promise.resolve(leadResult), /Integration Manager/);
  releaseGet();
  const prepared = await prepareResult as { status: string; managerAgentId: string };
  assert.equal(prepared.status, "provisioned");
  assert.equal(prepared.managerAgentId, MANAGER);
  await leadRejected;
  assert.deepEqual(f.states.get(keyId(integrationManagerStateKey(WORKSPACE))), {
    schemaVersion: 1, workspaceId: WORKSPACE, revision: 1, selectedAgentId: MANAGER,
  });
  assert.deepEqual(f.states.get(`${WORKSPACE}:lead-agent.v1`), { workspaceId: WORKSPACE, revision: 4, selectedAgentId: LEAD });
});

test("Manager action routes reject foreign Workspace metadata before product operations", async () => {
  const f = fixture();
  const route = createBuilderPlatform().actions.find(item => item.key === "builder.prepare-integration-manager");
  assert.ok(route);
  await assert.rejects(() => Promise.resolve().then(() => route.handler({ companyId: "99999999-9999-4999-8999-999999999999", projectId: WORKSPACE,
    expectedManagerRevision: 0 }, f.platform)), /trusted Workspace|authenticated Workspace/iu);
  assert.deepEqual(f.writes, []);
});
