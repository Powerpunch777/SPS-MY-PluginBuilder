import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import type { PluginSpsArtifact, PluginSpsClient } from "@sonparkserver/plugin-sdk/runtime";
import { createCtoDeliveryStore, workstreamInstructionDigest } from "../cto-delivery-store.ts";
import { ctoDeliveryRequestId } from "../domain/cto-deliveries.ts";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import type { TaskPacketRecord } from "../domain/task-packets.ts";
import type { WorkstreamRecord } from "../domain/workstreams.ts";
import { readPersistedPlanningRecords } from "./index.ts";
import { createDeliveryAttemptProducer, listDeliveryAttempts, readCurrentDeliveryAttempt, type ReceiptHostFacade } from "./receipt-store.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ctoAgentId = "22222222-2222-4222-8222-222222222222";
const ctoSessionId = "33333333-3333-4333-8333-333333333333";
const ctoRunId = "44444444-4444-4444-8444-444444444444";
const workerSessionId = "55555555-5555-4555-8555-555555555555";
const dispatchRequestId = "77777777-7777-4777-8777-777777777777";
const dispatchRunId = "admitted-run-1";
const sourceRevision = { kind: "git-commit" as const, value: "a".repeat(40) };
const workstream: WorkstreamRecord = {
  spec: { projectId: "project-1", id: "workstream-1", revision: 1, sourceSpecRevisionId: "spec-1", assignedCtoId: "cto-1",
    title: "Evidence", goal: "Record delivery evidence", scopeNodeIds: ["node-1"], included: ["delivery evidence"], excluded: [],
    dependencies: [], interfaceContracts: [], technologyDecisionsRef: "tech-1", reuseCandidates: [], acceptance: ["Persist provenance"],
    evidenceRequired: ["source record"], openQuestions: [] },
  sourceBaselineRevisionId: "baseline-1", baselineDigest: "a".repeat(64), technologyDigest: "b".repeat(64), ctoAgentId,
  ctoSessionId, author: { agentId: ctoAgentId, sessionId: ctoSessionId, runId: ctoRunId, selectionRevision: 1 },
  createdAt: "2026-11-04T00:00:00.000Z", change: { previousRevision: null, reason: "initial", diff: "initial", impactNodeIds: [],
    impactInterfaceContracts: [], impactTaskIds: [], effectiveFrom: "now" }, receipt: null,
};
const packet: TaskPacketRecord = {
  packet: { projectId: "project-1", ctoId: "cto-1", workstreamId: "workstream-1", taskId: "task-1", revision: 3,
    kind: "development", title: "Build evidence", goal: "Bind actual admitted work", scopeNodeIds: ["node-1"], requirementIds: ["REQ-1"],
    dependencies: [], included: ["delivery evidence"], excluded: [], constraints: [], acceptance: ["preserve provenance"],
    evidenceRequired: ["actual dispatch"], reuse: [], testPlan: null },
  source: { requestId: "a49e8013-c12c-478d-99df-854cd4257091", workstreamId: "workstream-1", specRevision: 1,
    instructionSha256: workstreamInstructionDigest(workstream) },
  author: { agentId: ctoAgentId, sessionId: ctoSessionId, runId: ctoRunId }, createdAtISO: "2026-11-04T00:00:00.000Z", dependencyPins: [],
};

function memoryState() {
  const values = new Map<string, JsonValue>();
  return {
    get: async (key: { stateKey: string }) => values.get(key.stateKey) ?? null,
    compareAndSet: async (key: { stateKey: string }, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
      const current = values.get(key.stateKey);
      const matches = expected.exists ? current !== undefined && JSON.stringify(current) === JSON.stringify(expected.value) : current === undefined;
      if (matches) values.set(key.stateKey, value);
      return { swapped: matches };
    },
  };
}

async function preparedState(options: { instructionDigest?: string; packetAuthor?: TaskPacketRecord["author"] } = {}) {
  const state = memoryState();
  const requestId = ctoDeliveryRequestId(workspaceId, "project-1", "cto-1", workstream);
  const row: TaskPacketRecord = { ...packet, source: { ...packet.source, requestId,
    instructionSha256: options.instructionDigest ?? workstreamInstructionDigest(workstream) },
    author: options.packetAuthor ?? packet.author };
  const packets = createTaskPacketStore(workspaceId, "project-1", "cto-1", "workstream-1", state);
  await packets.publish({ expectedBaseRevisionId: null, revision: { projectId: "project-1", ctoId: "cto-1", workstreamId: "workstream-1",
    revisionId: "packet-board-1", packets: [row] } });
  const deliveries = createCtoDeliveryStore(workspaceId, "project-1", "cto-1", state);
  await deliveries.publish({ expectedBaseRevisionId: null, revision: { schemaVersion: 1, workspaceId, projectId: "project-1", ctoId: "cto-1",
    revisionId: "delivery-1", requestId, boardRevisionId: "workstream-board-1", instruction: workstream,
    requestedBy: { agentId: ctoAgentId, sessionId: ctoSessionId, runId: ctoRunId, selectionRevision: 1 },
    executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["builder.acknowledge-workstream", "builder.read-cto-workstream"] },
    createdAt: "2026-11-04T00:00:00.000Z", phase: "submitted", runId: "66666666-6666-4666-8666-666666666666",
    cancellationRequested: false, termination: "not_applicable", outputState: "not_ready", answer: null } });
  return { state, row };
}

const scope = { workspaceId, projectId: "project-1", ctoId: "cto-1", workstreamId: "workstream-1", taskId: "task-1", taskRevision: 3 };
const authority = { readCurrent: async () => ({ sourceRevision, companyId: workspaceId, pluginKey: "builder", subjectKey: "task-1" }) };
const artifact: PluginSpsArtifact = { id: "artifact-1", companyId: workspaceId, pluginKey: "builder", subjectKey: "task-1", runId: dispatchRunId,
  title: "Run output", kind: "test-result", referenceUrl: null, summary: null, data: {}, createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" };
const artifacts = { artifacts: { list: async () => [artifact] } } as unknown as PluginSpsClient;

function input(row: TaskPacketRecord, overrides: Partial<{ returnedRunId: string; dispatchRequestId: string; dispatchSessionId: string; recordedAtISO: string }> = {}) {
  return { ...scope, packet: row, returnedRunId: dispatchRunId, dispatchRequestId, dispatchSessionId: workerSessionId,
    recordedAtISO: "2026-11-04T03:00:00.000Z", ...overrides };
}

function host(state: ReturnType<typeof memoryState>, lookup: ReceiptHostFacade["agents"]["sessions"]["getRequest"]): ReceiptHostFacade {
  return { state, agents: { sessions: { getRequest: lookup } } };
}

test("instruction digest mismatch is rejected before admission lookup", async () => {
  const { state, row } = await preparedState({ instructionDigest: "f".repeat(64) });
  const linked = await readPersistedPlanningRecords({ ...scope, state });
  assert.equal(linked.status, "mismatched");
  let admissionLookups = 0;
  await assert.rejects(createDeliveryAttemptProducer().record(input(row), authority,
    host(state, async () => { admissionLookups += 1; return { requestId: dispatchRequestId, state: "submitted", runId: dispatchRunId }; }), artifacts),
  /Current persisted Task Packet/u);
  assert.equal(admissionLookups, 0);
});

test("getRequest response request ID and run ID must both match the returned dispatch", async () => {
  const { state, row } = await preparedState();
  const producer = createDeliveryAttemptProducer();
  const wrongRequest = host(state, async () => ({ requestId: "99999999-9999-4999-8999-999999999999", state: "submitted", runId: dispatchRunId }));
  await assert.rejects(producer.record(input(row), authority, wrongRequest, artifacts), /Core admission/u);
  const wrongRun = host(state, async () => ({ requestId: dispatchRequestId, state: "submitted", runId: "different-run" }));
  await assert.rejects(producer.record(input(row), authority, wrongRun, artifacts), /Core admission/u);
  assert.equal((await listDeliveryAttempts(scope, state)).attempts.length, 0);
});

test("same admitted attempt is immutable and ambiguous admission never triggers replay", async () => {
  const { state, row } = await preparedState();
  const producer = createDeliveryAttemptProducer();
  const confirmed = host(state, async (_sessionId, _companyId, requestId) => ({ requestId, state: "submitted", runId: dispatchRunId }));
  const first = await producer.record(input(row), authority, confirmed, artifacts);
  const duplicate = await producer.record(input(row), authority, confirmed, artifacts);
  assert.deepEqual(duplicate, first);
  await assert.rejects(producer.record(input(row, { recordedAtISO: "2026-11-04T03:01:00.000Z" }), authority, confirmed, artifacts), /immutable receipt content/u);
  assert.equal((await listDeliveryAttempts(scope, state)).attempts.length, 1);

  for (const stateName of ["pending", "uncertain"] as const) {
    const { state: ambiguousState, row: ambiguousRow } = await preparedState();
    let queriedSession = "";
    await assert.rejects(producer.record(input(ambiguousRow, { returnedRunId: `ambiguous-${stateName}` }), authority,
      host(ambiguousState, async (sessionId, _companyId, requestId) => {
        queriedSession = sessionId;
        return { requestId, state: stateName, runId: null };
      }), artifacts), /Core admission/u);
    assert.equal(queriedSession, workerSessionId);
    assert.equal((await listDeliveryAttempts(scope, ambiguousState)).attempts.length, 0);
  }
});

test("fake facade output keeps journal origin and evidence authority explicitly unattested", async () => {
  const { state, row } = await preparedState();
  const attempt = await createDeliveryAttemptProducer().record(input(row), authority,
    host(state, async (_sessionId, _companyId, requestId) => ({ requestId, state: "submitted", runId: dispatchRunId })), artifacts);
  assert.equal(attempt.journalOrigin, "unattested-host-state");
  assert.equal(attempt.evidenceStatus, "unknown");
  const observed = await readCurrentDeliveryAttempt({ ...scope, attemptId: dispatchRunId },
    host(state, async (_sessionId, _companyId, requestId) => ({ requestId, state: "submitted", runId: dispatchRunId })), authority, artifacts);
  assert.equal(observed.status, "observed");
  assert.equal(observed.evidenceAuthority, "unknown");
  assert.equal(observed.attempt?.journalOrigin, "unattested-host-state");
});

test("CTO session and sessions without a matching worker request are rejected", async () => {
  const { state, row } = await preparedState();
  const producer = createDeliveryAttemptProducer();
  for (const queriedSessionId of [ctoSessionId, workerSessionId]) {
    const attemptId = `no-request-${queriedSessionId}`;
    await assert.rejects(producer.record(input(row, { returnedRunId: attemptId, dispatchSessionId: queriedSessionId }), authority,
      host(state, async (sessionId, _companyId, requestId) => sessionId === workerSessionId
        ? { requestId, state: "submitted", runId: "another-session-run" } : null), artifacts), /Core admission/u);
  }
  assert.equal((await listDeliveryAttempts(scope, state)).attempts.length, 0);
});
