import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey, SpsAgentSessionRunResult } from "@sonparkserver/plugin-sdk/platform";
import { createWorkstreamStore } from "../../src/workstream-tools.ts";
import { createDesignBaselineStore } from "../../src/design-baseline-tools.ts";
import { createTechnologyDecisionStore } from "../../src/technology-decision-tools.ts";
import { inspectCtoWorkstreamDelivery } from "../../src/cto-workstream-delivery.ts";
import { createCtoDeliveryStore } from "../../src/cto-delivery-store.ts";

export const W = "11111111-1111-4111-8111-111111111111", A = "22222222-2222-4222-8222-222222222222";
export const S = "33333333-3333-4333-8333-333333333333", C = "44444444-4444-4444-8444-444444444444";
export const R = "55555555-5555-4555-8555-555555555555", P = "fixture-project", CTO = "cto-one";
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const key = (stateKey: string): SpsStateKey => ({ scopeKind: "company", scopeId: W, namespace: "sonpark.my-builder", stateKey });
export const mapKey = (input: SpsStateKey) => JSON.stringify(input);
export const ctx = (sessionId = S, runId = R) => ({ companyId: W, agentId: A, sessionId, runId });
export const now = "2026-11-02T01:02:03.004Z";

export async function fixture() {
  const values = new Map<string, JsonValue>();
  let writes = 0, sends = 0, cancelCalls = 0;
  let beforeCas = async (_input: SpsStateKey, _value: JsonValue) => {};
  let afterCas = async (_input: SpsStateKey, _value: JsonValue) => {};
  let afterSend = async (_runId: string) => {};
  const receipts = new Map<string, { requestId: string; state: "submitted"; runId: string }>();
  const runs = new Map<string, SpsAgentSessionRunResult>();
  const sent: Array<{ sessionId: string; requestId: string; prompt: string; executionPolicy: unknown }> = [];
  const state = {
    async get(input: SpsStateKey) { return structuredClone(values.get(mapKey(input)) ?? null); },
    async set() { throw new Error("No state.set fallback"); },
    async compareAndSet(input: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      await beforeCas(input, value);
      const old = values.get(mapKey(input));
      const swapped = expected.exists ? old !== undefined && JSON.stringify(old) === JSON.stringify(expected.value) : old === undefined;
      if (swapped) { writes++; values.set(mapKey(input), structuredClone(value)); await afterCas(input, value); }
      return { swapped };
    },
  };
  const sessions = {
    async describePolicySupport() { return { schemaVersion: 1, modes: ["plugin-tools-only-v1"], enforcement: "dispatch-and-run", readiness: "unknown", osIsolation: "not-certified" }; },
    async getRequest(sessionId: string, workspaceId: string, requestId: string) {
      assert.equal(workspaceId, W); assert.equal(sessionId, C);
      return structuredClone(receipts.get(requestId) ?? null);
    },
    async sendMessage(sessionId: string, workspaceId: string, options: { requestId: string; prompt: string; executionPolicy: unknown }) {
      assert.equal(workspaceId, W); assert.equal(sessionId, C);
      sends++; sent.push({ sessionId, ...options });
      const runId = randomUUID();
      receipts.set(options.requestId, { requestId: options.requestId, state: "submitted", runId });
      runs.set(runId, { runId, status: "running", cancellationRequested: false, termination: "not_applicable", error: null, errorCode: null,
        output: { state: "not_ready", text: null } });
      await afterSend(runId);
      return { runId };
    },
    async getRun(sessionId: string, workspaceId: string, runId: string) {
      assert.equal(sessionId, C); assert.equal(workspaceId, W);
      const value = runs.get(runId); if (!value) throw new Error("Unknown run"); return structuredClone(value);
    },
    async cancel(sessionId: string, workspaceId: string, runId: string) {
      assert.equal(sessionId, C); assert.equal(workspaceId, W); cancelCalls++;
      const value: SpsAgentSessionRunResult = { ...runs.get(runId)!, status: "cancelled", cancellationRequested: true,
        termination: "pending", output: { state: "withheld", text: null, reason: "not_successful" } };
      runs.set(runId, value); return structuredClone(value);
    },
  };
  const platform = { state, agents: { sessions } } as unknown as SpsPlatformInvocationContext;
  values.set(mapKey(key("lead-agent.v1")), { workspaceId: W, revision: 1, selectedAgentId: A });
  values.set(mapKey(key("lead-sessions.v1.1")), { workspaceId: W, selectionRevision: 1, agentId: A,
    sessions: { main: S, decisions: null, "cto-inbox": null } });
  const registryKey = key(`project-ctos.v1.${createHash("sha256").update(P).digest("hex")}`);
  const cto = { ctoId: CTO, displayName: "CTO", agentId: A, sessionId: C, status: "ACTIVE", createdAt: now,
    createdBy: { agentId: A, sessionId: S, runId: R, selectionRevision: 1 } };
  values.set(mapKey(registryKey), { schemaVersion: 1, workspaceId: W, projectId: P, revision: 1, ctos: [cto] });
  const baseline = { projectId: P, revisionId: "baseline-1", sourceDraftRevisionId: "draft-1", draftDigest: "a".repeat(64), createdAt: now,
    author: { agentId: A, sessionId: S, runId: R, selectionRevision: 1 },
    userDecision: { sourceId: `lead-turn:${R}`, sourceSha256: "b".repeat(64), interpretation: "Fixture planning decision" },
    specification: { projectId: P, revisionId: "spec-1", productTier: "S", requirements: [{ id: "REQ-1", description: "Feature", acceptanceCriteriaIds: ["AC-1"] }],
      targets: ["desktop"], dataPolicyRef: "local-policy", approvalEvidenceRef: `lead-turn:${R}` },
    graph: { approvedSpecRevisionId: "spec-1", graphRevisionId: "graph-1", entities: [{ id: "feature", kind: "feature", specRef: "REQ-1" }], relations: [], viewLayoutRef: "layout-1" } };
  const baselineStore = createDesignBaselineStore(W, P, state);
  await baselineStore.publish({ expectedBaseRevisionId: null, revision: baseline });
  const storedBaseline = (await baselineStore.current())!.revision;
  await createTechnologyDecisionStore(W, P, state).publish({ expectedBaseRevisionId: null, revision: {
    register: { projectId: P, revisionId: "tech-1", sourceBaselineRevisionId: "baseline-1", sourceSpecRevisionId: "spec-1", sourceGraphRevisionId: "graph-1", entries: [] },
    baselineDigest: digest(storedBaseline), author: baseline.author, createdAt: now } });
  const tech = (await createTechnologyDecisionStore(W, P, state).current())!.revision;
  const instruction = { spec: { projectId: P, id: "ws-1", revision: 1, sourceSpecRevisionId: "spec-1", assignedCtoId: CTO,
    title: "Feature", goal: "Plan the feature", scopeNodeIds: ["feature"], included: ["Feature"], excluded: [], dependencies: [], interfaceContracts: [],
    technologyDecisionsRef: "tech-1", reuseCandidates: [], acceptance: ["Test"], evidenceRequired: ["Evidence"], openQuestions: [] },
    sourceBaselineRevisionId: "baseline-1", baselineDigest: digest(storedBaseline), technologyDigest: digest(tech), ctoAgentId: A, ctoSessionId: C,
    author: baseline.author, createdAt: now, change: { previousRevision: null, reason: "Initial", diff: "Create", impactNodeIds: ["feature"], impactInterfaceContracts: [], impactTaskIds: [], effectiveFrom: "After receipt" }, receipt: null };
  await createWorkstreamStore(W, P, state).publish({ expectedBaseRevisionId: null, revision: { projectId: P, revisionId: "board-1", workstreams: [instruction] } });
  const params = { projectId: P, workstreamId: "ws-1", specRevision: 1, boardRevisionId: "board-1" };
  const inspect = () => inspectCtoWorkstreamDelivery({ projectId: P, ctoId: CTO }, ctx(), platform);
  const deliveryStore = () => createCtoDeliveryStore(W, P, CTO, state);
  return { platform, state, values, receipts, runs, sent, params, inspect, deliveryStore, instruction, baseline, registryKey, cto,
    get sends() { return sends; }, get writes() { return writes; }, get cancelCalls() { return cancelCalls; },
    setBeforeCas(hook: typeof beforeCas) { beforeCas = hook; }, setAfterCas(hook: typeof afterCas) { afterCas = hook; },
    setAfterSend(hook: typeof afterSend) { afterSend = hook; } };
}
