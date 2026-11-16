import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { ensureIntegrationManagerDefaultProfile, INTEGRATION_MANAGER_OWNED_ADAPTER_CONTRACT } from "../src/delivery-evidence/integration-manager-default.ts";
import { INTEGRATION_MANAGER_DEFAULT_PROFILE, INTEGRATION_MANAGER_OWNED_AGENT_KEY, INTEGRATION_MANAGER_SESSION_TASK_KEY } from "../src/domain/integration-manager.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const MANAGER_SESSION = "44444444-4444-4444-8444-444444444444";
const stateId = (key: SpsStateKey) => `${key.scopeId}/${key.stateKey}`;

function fixture(options: { selection?: { revision: number; selectedAgentId: string | null } | null; owned?: boolean;
  raceProfile?: boolean; ownedStatus?: "created" | "resolved" | "updated" | "uncertain"; createdProfileStatus?: string;
  loseFirstEnsureReply?: boolean } = {}) {
  const state = new Map<string, JsonValue>();
  if (options.selection) state.set(`${WORKSPACE}/integration-manager-agent.v1`, {
    schemaVersion: 1, workspaceId: WORKSPACE, ...options.selection,
  });
  state.set(`${WORKSPACE}/lead-agent.v1`, { workspaceId: WORKSPACE, revision: 4, selectedAgentId: LEAD });
  let profileEnsureCalls = 0;
  let agentListCalls = 0;
  let sessionEnsureCalls = 0;
  type AgentProfile = { agentId: string; name: string; role: string; title: string | null; icon: string | null;
    capabilities: string | null; adapterType: string; status: string; instructions: string | null;
    executionDefaults: { provider?: string | null; model?: string | null; reasoningEffort?: string | null } };
  let profile: AgentProfile | null = null;
  const context = {
    companyId: WORKSPACE,
    actor: { type: "user" as const, companyId: WORKSPACE, userId: "host-user" },
    state: {
      async get(key: SpsStateKey) { return structuredClone(state.get(stateId(key)) ?? null); },
      async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
        const id = stateId(key), present = state.has(id), current = state.get(id);
        const matches = expected.exists ? present && JSON.stringify(current) === JSON.stringify(expected.value) : !present;
        if (matches) state.set(id, structuredClone(value));
        return { swapped: matches };
      },
    },
    projectId: WORKSPACE,
    agents: {
      async list({ companyId }: { companyId: string; limit: number }) {
        agentListCalls += 1;
        assert.equal(companyId, WORKSPACE);
        return [{ id: MANAGER, companyId }, { id: LEAD, companyId }];
      },
      async describeExecution(agentId: string, companyId: string) {
        assert.equal(agentId, LEAD);
        assert.equal(companyId, WORKSPACE);
        return { agentId, adapterType: "codex_local", state: "configured", adapterRegistration: "registered",
          executionOwner: "adapter", authorization: "recheck_on_dispatch", readiness: "unknown", node: null };
      },
      ...(options.owned ? { owned: {
        async get(input: { companyId: string; pluginAgentKey: string }) {
          assert.equal(input.companyId, WORKSPACE);
          assert.equal(input.pluginAgentKey, INTEGRATION_MANAGER_OWNED_AGENT_KEY);
          if (options.raceProfile && !profile) profile = { agentId: MANAGER, name: "User Manager", role: "custom-role",
            title: null, icon: null, capabilities: null, adapterType: "neutral", status: "active",
            instructions: "Keep custom config", executionDefaults: { provider: "user-provider" } };
          return profile ? { status: "resolved", revision: 2, agent: profile } : { status: "missing" };
        },
        async ensure(input: { companyId: string; pluginAgentKey: string; config: typeof INTEGRATION_MANAGER_DEFAULT_PROFILE;
          adapterPreference?: readonly string[] }) {
          profileEnsureCalls += 1;
          assert.equal(input.companyId, WORKSPACE);
          assert.equal(input.pluginAgentKey, INTEGRATION_MANAGER_OWNED_AGENT_KEY);
          assert.deepEqual(input.config, INTEGRATION_MANAGER_DEFAULT_PROFILE);
          assert.deepEqual(input.adapterPreference, ["codex_local"]);
          if (options.ownedStatus === "uncertain") return { status: "uncertain" };
          if (!profile) profile = { agentId: MANAGER, name: input.config.name, role: input.config.role, title: null,
            icon: null, capabilities: null, adapterType: "neutral", status: options.createdProfileStatus ?? "paused",
            instructions: input.config.instructions,
            executionDefaults: {} };
          if (options.loseFirstEnsureReply && profileEnsureCalls === 1) throw new Error("ensure reply lost after commit");
          return { status: options.ownedStatus ?? "created", revision: 1, agent: profile };
        },
      } } : {}),
      sessions: {
        async ensure(agentId: string, companyId: string, options: { taskKey: string; expectedSessionId?: string }) {
          sessionEnsureCalls += 1;
          assert.equal(agentId, MANAGER);
          assert.equal(companyId, WORKSPACE);
          assert.match(options.taskKey, new RegExp(`^${INTEGRATION_MANAGER_SESSION_TASK_KEY}:`));
          return { sessionId: options.expectedSessionId ?? MANAGER_SESSION, created: options.expectedSessionId === undefined };
        },
      },
    },
  };
  return { context, state, counts: () => ({ profileEnsureCalls, agentListCalls, sessionEnsureCalls }), get profile() { return profile; } };
}

const input = { projectId: WORKSPACE, expectedManagerRevision: 0 };

test("absent owned capability stays UNKNOWN and performs no state write", async () => {
  const f = fixture();
  const result = await ensureIntegrationManagerDefaultProfile(input, f.context);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "host-owned-agent-api-or-agents-owned-manage-unavailable");
  assert.equal(result.authorityConsistency, "cross-key-reads-are-not-atomic");
  assert.equal(result.profileProvisioning, "not-attempted");
  assert.equal(f.counts().agentListCalls, 0);
  assert.equal(f.counts().profileEnsureCalls, 0);
  assert.equal(f.state.size, 1, "the synthetic current Lead binding is fixture setup, not a Manager write");
  assert.equal(f.state.has(`${WORKSPACE}/integration-manager-agent.v1`), false);
  assert.equal(result.authorityConsistency, "cross-key-reads-are-not-atomic");
  assert.equal(INTEGRATION_MANAGER_OWNED_AGENT_KEY, "integration-manager");
  assert.equal(INTEGRATION_MANAGER_DEFAULT_PROFILE.name, "Integration Manager");
});

test("a synthetic root context.owned object is not treated as the public agents.owned adapter", async () => {
  const f = fixture();
  let calls = 0;
  const nonPublic = { ...f.context, owned: { async ensure() { calls += 1; return {}; } } };
  const result = await ensureIntegrationManagerDefaultProfile(input, nonPublic);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "host-owned-agent-api-or-agents-owned-manage-unavailable");
  assert.equal(calls, 0);
  assert.equal(f.state.size, 1, "the synthetic current Lead binding is fixture setup, not a Manager write");
  assert.equal(f.state.has(`${WORKSPACE}/integration-manager-agent.v1`), false);
});

test("creates and binds a default Manager through the stable owned-ensure operation", async () => {
  const f = fixture({ owned: true });
  const result = await ensureIntegrationManagerDefaultProfile(input, f.context);
  assert.equal(result.status, "provisioned");
  assert.equal(result.managerAgentId, MANAGER);
  assert.equal(result.managerRevision, 1);
  assert.equal(result.executionReadiness, "unknown");
  assert.equal(result.authorityConsistency, "cross-key-reads-are-not-atomic");
  assert.equal(INTEGRATION_MANAGER_OWNED_ADAPTER_CONTRACT.sdkCapability, "agents.owned.manage");
  assert.equal(f.counts().profileEnsureCalls, 1);
  assert.equal(f.counts().agentListCalls, 2, "the current Lead and the resolved Manager are independently checked in Workspace scope");
  assert.equal(f.counts().sessionEnsureCalls, 1);
  assert.equal(result.managerSessionId, MANAGER_SESSION);
  assert.equal(result.aiRunStarted, false);
  assert.deepEqual(f.state.get(`${WORKSPACE}/integration-manager-agent.v1`), {
    schemaVersion: 1, workspaceId: WORKSPACE, revision: 1, selectedAgentId: MANAGER,
  });
});

test("a racing existing same-key profile is resolved unchanged, never replaced by defaults", async () => {
  const f = fixture({ owned: true, raceProfile: true });
  const result = await ensureIntegrationManagerDefaultProfile(input, f.context);
  assert.equal(result.status, "provisioned");
  assert.equal(result.managerAgentId, MANAGER);
  assert.equal(f.profile?.name, "User Manager");
  assert.equal(f.profile?.role, "custom-role");
  assert.equal(f.profile?.instructions, "Keep custom config");
  assert.equal(f.counts().profileEnsureCalls, 0, "an existing keyed profile is read, never sent through ensure");
});

test("ensure updated is rejected and never bound as a provisioning success", async () => {
  const f = fixture({ owned: true, ownedStatus: "updated" });
  const result = await ensureIntegrationManagerDefaultProfile(input, f.context);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "host-owned-profile-not-created-or-resolved");
  assert.equal(f.state.has(`${WORKSPACE}/integration-manager-agent.v1`), false);
});

test("Core ensure uncertainty after a confirmed Lead adapter preference stays UNKNOWN and unbound", async () => {
  const f = fixture({ owned: true, ownedStatus: "uncertain" });
  const result = await ensureIntegrationManagerDefaultProfile(input, f.context);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "host-owned-profile-ensure-uncertain-after-adapter-preference");
  assert.equal(f.counts().profileEnsureCalls, 1);
  assert.equal(f.counts().sessionEnsureCalls, 0);
  assert.equal(f.state.has(`${WORKSPACE}/integration-manager-agent.v1`), false);
});

test("a newly created active profile is rejected and never bound as the paused default", async () => {
  const f = fixture({ owned: true, createdProfileStatus: "active" });
  const result = await ensureIntegrationManagerDefaultProfile(input, f.context);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "host-owned-created-profile-not-paused");
  assert.equal(f.state.has(`${WORKSPACE}/integration-manager-agent.v1`), false);
  assert.equal(f.counts().sessionEnsureCalls, 0);
});

test("a lost ensure reply is recovered on deliberate retry by the same stable owned key", async () => {
  const f = fixture({ owned: true, loseFirstEnsureReply: true });
  const first = await ensureIntegrationManagerDefaultProfile(input, f.context);
  assert.equal(first.status, "unknown");
  assert.equal(first.reason, "host-owned-agent-operation-uncertain");
  assert.equal(f.state.has(`${WORKSPACE}/integration-manager-agent.v1`), false);
  const recovered = await ensureIntegrationManagerDefaultProfile(input, f.context);
  assert.equal(recovered.status, "provisioned");
  assert.equal(recovered.managerAgentId, MANAGER);
  assert.equal(f.counts().profileEnsureCalls, 1, "retry reads the committed owned key and does not repeat ensure");
});

test("preserves an existing Manager selection only after Workspace membership and readback", async () => {
  const f = fixture({ selection: { revision: 1, selectedAgentId: MANAGER } });
  const result = await ensureIntegrationManagerDefaultProfile({ ...input, expectedManagerRevision: 1 }, f.context);
  assert.equal(result.status, "preserved");
  assert.equal(result.managerAgentId, MANAGER);
  assert.equal(result.executionReadiness, "unknown");
  assert.equal(f.counts().agentListCalls, 1);
  assert.equal(f.counts().profileEnsureCalls, 0);
});

test("an explicit empty selection at a nonzero revision is a preserved user pause", async () => {
  const f = fixture({ selection: { revision: 2, selectedAgentId: null } });
  const result = await ensureIntegrationManagerDefaultProfile({ ...input, expectedManagerRevision: 2 }, f.context);
  assert.equal(result.status, "preserved");
  assert.equal(result.reason, "user-paused");
  assert.equal(f.counts().agentListCalls, 0);
});

test("rejects agent, cross-Workspace, malformed and stale requests before provisioning", async () => {
  const f = fixture();
  await assert.rejects(ensureIntegrationManagerDefaultProfile(input, { ...f.context,
    actor: { type: "agent", companyId: WORKSPACE, userId: null } }), /Host-authenticated user/u);
  await assert.rejects(ensureIntegrationManagerDefaultProfile(input, { ...f.context,
    actor: { type: "user", companyId: LEAD, userId: "host-user" } }), /Host-authenticated user/u);
  await assert.rejects(ensureIntegrationManagerDefaultProfile({ ...input, extra: true }, f.context), /Invalid Integration Manager preparation input/u);
  await assert.rejects(ensureIntegrationManagerDefaultProfile({ ...input, projectId: "bad project" }, f.context), /Invalid Integration Manager preparation input/u);
  assert.equal(f.counts().profileEnsureCalls, 0);
});
