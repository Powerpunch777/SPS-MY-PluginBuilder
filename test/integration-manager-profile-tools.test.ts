import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { createIntegrationManagerProfilePreparationHandler, prepareIntegrationManagerDefaultProfile } from "../src/delivery-evidence/integration-manager-default.ts";
import { INTEGRATION_MANAGER_DEFAULT_PROFILE, INTEGRATION_MANAGER_OWNED_AGENT_KEY,
  integrationManagerSessionStateKey, integrationManagerSessionTaskKey, legacyIntegrationManagerSessionTaskKey,
  legacyIntegrationManagerSessionStateKey } from "../src/domain/integration-manager.ts";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const LEAD_SESSION = "44444444-4444-4444-8444-444444444444";
const MANAGER_SESSION = "55555555-5555-4555-8555-555555555555";
const MANAGER_B = "66666666-6666-4666-8666-666666666666";
const SESSION_B = "77777777-7777-4777-8777-777777777777";
const LEGACY_SESSION_A = "88888888-8888-4888-8888-888888888888";
const PROJECT = WORKSPACE;
const id = (key: SpsStateKey) => `${key.scopeId}/${key.stateKey}`;

// TEST_FIXTURE_ONLY: fake Host capabilities, state, identities, profile receipts and sessions; no actual Host/user data/auth.
function fixture(options: { selection?: { revision: number; selectedAgentId: string | null }; noOwned?: boolean;
  currentLead?: boolean; leadAgentId?: string; sessionConflict?: boolean; leadAdapterState?: string;
  otherManagerIds?: readonly string[]; sessionIds?: Readonly<Record<string, string>>;
  onSessionEnsure?: () => void } = {}) {
  const state = new Map<string, JsonValue>();
  if (options.selection) state.set(`${WORKSPACE}/integration-manager-agent.v1`, {
    schemaVersion: 1, workspaceId: WORKSPACE, ...options.selection,
  });
  state.set(`${WORKSPACE}/lead-agent.v1`, { workspaceId: WORKSPACE, revision: 4,
    selectedAgentId: options.currentLead ? options.leadAgentId ?? MANAGER : LEAD });
  if (options.sessionConflict) state.set(`${WORKSPACE}/lead-sessions.v1.4`, {
    workspaceId: WORKSPACE, selectionRevision: 4, agentId: LEAD,
    sessions: { main: LEAD_SESSION, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null },
  });
  const returnLeadSession = options.sessionConflict === true;
  let profileReads = 0, profileCreates = 0, sessionEnsures = 0, sendCalls = 0;
  const sessionArguments: Array<{ agentId: string; companyId: string; taskKey: string; expectedSessionId?: string }> = [];
  const sessionsByTaskKey = new Map<string, string>();
  const profile = { agentId: MANAGER, name: "Integration Manager", role: "integration-manager", title: null, icon: null,
    capabilities: null, adapterType: "codex_local", status: "paused", instructions: INTEGRATION_MANAGER_DEFAULT_PROFILE.instructions,
    executionDefaults: { provider: "user-configured-provider", model: "user-configured-model", reasoningEffort: "high" } };
  const hostScope = {
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    state: {
      async get(key: SpsStateKey) { return structuredClone(state.get(id(key)) ?? null); },
      async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
        const keyId = id(key), current = state.get(keyId), exists = state.has(keyId);
        const swapped = expected.exists ? exists && JSON.stringify(current) === JSON.stringify(expected.value) : !exists;
        if (swapped) state.set(keyId, structuredClone(value));
        return { swapped };
      },
    },
    agents: {
      async list({ companyId }: { companyId: string; limit: number }) {
        assert.equal(companyId, WORKSPACE);
        return [{ id: MANAGER, companyId, status: "paused" }, ...(options.otherManagerIds ?? []).map(id => ({ id, companyId, status: "paused" })),
          { id: LEAD, companyId, status: "idle" }];
      },
      async describeExecution(agentId: string, companyId: string) {
        assert.equal(agentId, LEAD);
        assert.equal(companyId, WORKSPACE);
        return { agentId, adapterType: "codex_local", state: options.leadAdapterState ?? "configured",
          adapterRegistration: "registered", executionOwner: "adapter", authorization: "recheck_on_dispatch",
          readiness: "unknown", node: null };
      },
      ...(!options.noOwned ? { owned: {
        async get(input: { companyId: string; pluginAgentKey: string }) {
          profileReads += 1;
          assert.equal(input.companyId, WORKSPACE);
          assert.equal(input.pluginAgentKey, INTEGRATION_MANAGER_OWNED_AGENT_KEY);
          return { status: "missing" };
        },
        async ensure(input: { companyId: string; pluginAgentKey: string; config: typeof INTEGRATION_MANAGER_DEFAULT_PROFILE;
          adapterPreference?: readonly string[] }) {
          profileCreates += 1;
          assert.equal(input.companyId, WORKSPACE);
          assert.equal(input.pluginAgentKey, INTEGRATION_MANAGER_OWNED_AGENT_KEY);
          assert.deepEqual(input.config, INTEGRATION_MANAGER_DEFAULT_PROFILE);
          assert.equal(Object.hasOwn(input.config, "executionDefaults"), false, "do not clone/force model configuration");
          assert.deepEqual(input.adapterPreference, ["codex_local"]);
          return { status: "created", revision: 1, agent: profile };
        },
      } } : {}),
      sessions: {
        async ensure(agentId: string, companyId: string, sessionOptions: { taskKey: string; expectedSessionId?: string }) {
          sessionEnsures += 1;
          sessionArguments.push({ agentId, companyId, ...sessionOptions });
          options.onSessionEnsure?.();
          const already = sessionsByTaskKey.get(sessionOptions.taskKey);
          if (already) return { sessionId: already, created: false };
          if (sessionOptions.expectedSessionId) {
            sessionsByTaskKey.set(sessionOptions.taskKey, sessionOptions.expectedSessionId);
            return { sessionId: sessionOptions.expectedSessionId, created: false };
          }
          const sessionId = options.sessionIds?.[agentId] ?? (returnLeadSession ? LEAD_SESSION : MANAGER_SESSION);
          sessionsByTaskKey.set(sessionOptions.taskKey, sessionId);
          return { sessionId, created: true };
        },
        async sendMessage() { sendCalls += 1; throw new Error("Preparation must not send a message."); },
      },
    },
    async assertCurrentScope() {
      assert.equal(this.workspaceId, WORKSPACE);
      assert.equal(this.projectId, PROJECT);
    },
  };
  return { hostScope, state, sessionArguments, counts: () => ({ profileReads, profileCreates, sessionEnsures, sendCalls }) };
}

const firstInput = { projectId: PROJECT, expectedManagerRevision: 0 };

test("the same Host-scoped producer supports authenticated job registration without inventing actor credentials", async () => {
  const f = fixture();
  const handler = createIntegrationManagerProfilePreparationHandler(async (_input, hostContext: { workspaceId: string }) => {
    assert.equal(hostContext.workspaceId, WORKSPACE);
    return f.hostScope;
  });
  const result = await handler(firstInput, { workspaceId: WORKSPACE });
  assert.equal(result.status, "provisioned");
  assert.equal(result.profileStatus, "paused");
  assert.equal(result.managerSessionId, MANAGER_SESSION);
  assert.equal(result.executionReadiness, "unknown");
  assert.equal(result.aiRunStarted, false);
  assert.equal(f.counts().sendCalls, 0);
  assert.equal(f.counts().profileCreates, 1);
  assert.equal(f.counts().sessionEnsures, 1);
  assert.equal(f.sessionArguments[0]!.taskKey, integrationManagerSessionTaskKey(WORKSPACE, PROJECT, MANAGER));
  assert.deepEqual(f.state.get(id(integrationManagerSessionStateKey(WORKSPACE, PROJECT, MANAGER))), {
    schemaVersion: 1, workspaceId: WORKSPACE, projectId: PROJECT, managerAgentId: MANAGER, sessionId: MANAGER_SESSION,
    taskKey: integrationManagerSessionTaskKey(WORKSPACE, PROJECT, MANAGER),
  });
});

test("rejects a different project before any owned profile or session effect", async () => {
  const f = fixture();
  const result = await prepareIntegrationManagerDefaultProfile({ ...firstInput, projectId: "other-project" }, f.hostScope);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "integration-manager-requires-the-authenticated-single-project-workspace");
  assert.deepEqual(f.counts(), { profileReads: 0, profileCreates: 0, sessionEnsures: 0, sendCalls: 0 });
});

test("a current Lead adapter that is not explicitly configured cannot authorize a default adapter preference", async () => {
  const f = fixture({ leadAdapterState: "unknown" });
  const result = await prepareIntegrationManagerDefaultProfile(firstInput, f.hostScope);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "current-lead-adapter-selection-unconfirmed");
  assert.equal(f.counts().profileCreates, 0);
  assert.equal(f.counts().sessionEnsures, 0);
});

test("current Lead Agent and any prepared Lead session identity cannot be reused", async () => {
  const leadAgent = fixture({ selection: { revision: 1, selectedAgentId: MANAGER }, currentLead: true });
  const agentResult = await prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: 1 }, leadAgent.hostScope);
  assert.equal(agentResult.status, "unknown");
  assert.equal(agentResult.reason, "manager-agent-matches-current-lead");
  assert.equal(leadAgent.counts().sessionEnsures, 0);

  const leadSession = fixture({ selection: { revision: 1, selectedAgentId: MANAGER }, currentLead: true,
    leadAgentId: LEAD, sessionConflict: true });
  const sessionResult = await prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: 1 }, leadSession.hostScope);
  assert.equal(sessionResult.status, "unknown");
  assert.equal(sessionResult.reason, "host-manager-session-ensure-invalid-or-shared");
  assert.equal(leadSession.counts().sessionEnsures, 1, "the actual Host-returned key is checked against current Lead sessions");
});

test("a user-selected Manager and session binding survive recheck without profile writes or session replacement", async () => {
  const f = fixture({ selection: { revision: 1, selectedAgentId: MANAGER } });
  const first = await prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: 1 }, f.hostScope);
  assert.equal(first.status, "preserved");
  assert.equal(first.profileProvisioning, "not-required");
  assert.equal(f.counts().profileReads, 0);
  assert.equal(f.counts().sessionEnsures, 1);
  const second = await prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: 1 }, f.hostScope);
  assert.equal(second.status, "preserved");
  assert.equal(second.sessionProvisioning, "already-present");
  assert.deepEqual(f.sessionArguments[1], { agentId: MANAGER, companyId: WORKSPACE,
    taskKey: f.sessionArguments[0]!.taskKey, expectedSessionId: MANAGER_SESSION });
  assert.equal(f.counts().profileCreates, 0);
  assert.equal(f.counts().sendCalls, 0);
});

test("Manager A to B to A reuses two independent stable Core session keys and preserves both records", async () => {
  const f = fixture({ selection: { revision: 1, selectedAgentId: MANAGER }, otherManagerIds: [MANAGER_B],
    sessionIds: { [MANAGER]: MANAGER_SESSION, [MANAGER_B]: SESSION_B } });
  const run = (revision: number) => prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: revision }, f.hostScope);
  const aFirst = await run(1);
  assert.equal(aFirst.status, "preserved");
  assert.equal(aFirst.managerSessionId, MANAGER_SESSION);
  f.state.set(`${WORKSPACE}/integration-manager-agent.v1`, { schemaVersion: 1, workspaceId: WORKSPACE,
    revision: 2, selectedAgentId: MANAGER_B });
  const b = await run(2);
  assert.equal(b.status, "preserved");
  assert.equal(b.managerSessionId, SESSION_B);
  f.state.set(`${WORKSPACE}/integration-manager-agent.v1`, { schemaVersion: 1, workspaceId: WORKSPACE,
    revision: 3, selectedAgentId: MANAGER });
  const aAgain = await run(3);
  assert.equal(aAgain.status, "preserved");
  assert.equal(aAgain.managerSessionId, MANAGER_SESSION);
  const aKey = id(integrationManagerSessionStateKey(WORKSPACE, PROJECT, MANAGER));
  const bKey = id(integrationManagerSessionStateKey(WORKSPACE, PROJECT, MANAGER_B));
  assert.notEqual(aKey, bKey);
  assert.equal((f.state.get(aKey) as { sessionId: string }).sessionId, MANAGER_SESSION);
  assert.equal((f.state.get(bKey) as { sessionId: string }).sessionId, SESSION_B);
  assert.equal(f.sessionArguments[0]!.taskKey, integrationManagerSessionTaskKey(WORKSPACE, PROJECT, MANAGER));
  assert.equal(f.sessionArguments[1]!.taskKey, integrationManagerSessionTaskKey(WORKSPACE, PROJECT, MANAGER_B));
  assert.equal(f.sessionArguments[2]!.taskKey, f.sessionArguments[0]!.taskKey);
  assert.deepEqual(f.sessionArguments[2], { agentId: MANAGER, companyId: WORKSPACE,
    taskKey: f.sessionArguments[0]!.taskKey, expectedSessionId: MANAGER_SESSION });
});

test("legacy project-only binding is adopted only for its exact Manager Agent and never overwritten", async () => {
  const sameAgent = fixture({ selection: { revision: 1, selectedAgentId: MANAGER } });
  const legacyKey = id(legacyIntegrationManagerSessionStateKey(WORKSPACE, PROJECT));
  const oldRecord = { schemaVersion: 1, workspaceId: WORKSPACE, projectId: PROJECT,
    managerAgentId: MANAGER, sessionId: LEGACY_SESSION_A };
  sameAgent.state.set(legacyKey, oldRecord);
  const adopted = await prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: 1 }, sameAgent.hostScope);
  assert.equal(adopted.status, "preserved");
  assert.equal(adopted.managerSessionId, LEGACY_SESSION_A);
  assert.equal(sameAgent.sessionArguments[0]!.taskKey, legacyIntegrationManagerSessionTaskKey(WORKSPACE, PROJECT));
  assert.deepEqual(sameAgent.sessionArguments[0]!.expectedSessionId, LEGACY_SESSION_A);
  assert.deepEqual(sameAgent.state.get(legacyKey), oldRecord, "legacy record stays intact");
  assert.deepEqual(sameAgent.state.get(id(integrationManagerSessionStateKey(WORKSPACE, PROJECT, MANAGER))), {
    ...oldRecord, taskKey: legacyIntegrationManagerSessionTaskKey(WORKSPACE, PROJECT),
  });
  const rechecked = await prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: 1 }, sameAgent.hostScope);
  assert.equal(rechecked.managerSessionId, LEGACY_SESSION_A);
  assert.equal(rechecked.sessionProvisioning, "already-present");
  assert.equal(sameAgent.sessionArguments[1]!.taskKey, legacyIntegrationManagerSessionTaskKey(WORKSPACE, PROJECT));
  assert.equal(sameAgent.sessionArguments[1]!.expectedSessionId, LEGACY_SESSION_A);

  const foreignManager = fixture({ selection: { revision: 1, selectedAgentId: MANAGER } });
  foreignManager.state.set(legacyKey, { ...oldRecord, managerAgentId: MANAGER_B });
  const independent = await prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: 1 }, foreignManager.hostScope);
  assert.equal(independent.status, "preserved");
  assert.equal(independent.managerSessionId, MANAGER_SESSION);
  assert.equal(foreignManager.sessionArguments[0]!.taskKey, integrationManagerSessionTaskKey(WORKSPACE, PROJECT, MANAGER));
  assert.equal(Object.hasOwn(foreignManager.sessionArguments[0]!, "expectedSessionId"), false);
  assert.deepEqual(foreignManager.state.get(legacyKey), { ...oldRecord, managerAgentId: MANAGER_B });
});

test("selection change during session ensure blocks stale success and leaves only the scoped immutable session", async () => {
  const f = fixture({ selection: { revision: 1, selectedAgentId: MANAGER }, otherManagerIds: [MANAGER_B],
    onSessionEnsure() {
      f.state.set(`${WORKSPACE}/integration-manager-agent.v1`, { schemaVersion: 1, workspaceId: WORKSPACE,
        revision: 2, selectedAgentId: MANAGER_B });
    } });
  const result = await prepareIntegrationManagerDefaultProfile({ ...firstInput, expectedManagerRevision: 1 }, f.hostScope);
  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "manager-selection-changed-during-session-ensure");
  assert.equal(result.managerAgentId, MANAGER_B);
  assert.equal(f.state.has(id(integrationManagerSessionStateKey(WORKSPACE, PROJECT, MANAGER))), false);
  assert.equal(f.sessionArguments.length, 1, "the Host ensure can finish but does not produce stale published binding success");
});

test("old Host without owned API remains unsupported and never falls back to another Agent", async () => {
  const f = fixture({ noOwned: true });
  const result = await prepareIntegrationManagerDefaultProfile(firstInput, f.hostScope);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "host-owned-agent-api-or-agents-owned-manage-unavailable");
  assert.equal(f.counts().sessionEnsures, 0);
  assert.equal(f.state.has(`${WORKSPACE}/integration-manager-agent.v1`), false);
});
