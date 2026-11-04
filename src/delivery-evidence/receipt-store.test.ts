import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import type { PluginSpsArtifact, PluginSpsClient } from "@sonparkserver/plugin-sdk/runtime";
import { createCtoDeliveryStore, workstreamInstructionDigest } from "../cto-delivery-store.ts";
import { ctoDeliveryRequestId } from "../domain/cto-deliveries.ts";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import type { TaskPacketRecord } from "../domain/task-packets.ts";
import type { WorkstreamRecord } from "../domain/workstreams.ts";
import { createDeliveryAttemptProducer, listDeliveryAttempts, readCurrentDeliveryAttempt } from "./receipt-store.ts";
import { readPersistedPlanningRecords } from "./index.ts";
import { readPlanningJournalLinkage } from "./receipt-store.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const taskRunId = "44444444-4444-4444-8444-444444444444";
const source = { kind: "git-commit" as const, value: "a".repeat(40) };
const workstream: WorkstreamRecord = {
  spec: { projectId: "project-1", id: "workstream-1", revision: 1, sourceSpecRevisionId: "spec-1", assignedCtoId: "cto-1",
    title: "Evidence", goal: "Record delivery evidence", scopeNodeIds: ["node-1"], included: ["delivery evidence"], excluded: [],
    dependencies: [], interfaceContracts: [], technologyDecisionsRef: "tech-1", reuseCandidates: [], acceptance: ["Persist provenance"],
    evidenceRequired: ["source record"], openQuestions: [] },
  sourceBaselineRevisionId: "baseline-1", baselineDigest: "a".repeat(64), technologyDigest: "b".repeat(64), ctoAgentId: actorId,
  ctoSessionId: sessionId, author: { agentId: actorId, sessionId, runId: taskRunId, selectionRevision: 1 },
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
  author: { agentId: actorId, sessionId, runId: taskRunId }, createdAtISO: "2026-11-04T00:00:00.000Z", dependencyPins: [],
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

async function publishedState(packetRecord: TaskPacketRecord = packet, bindRequest = true) {
  const state = memoryState();
  const requestId = ctoDeliveryRequestId(workspaceId, "project-1", "cto-1", workstream);
  const row: TaskPacketRecord = { ...packetRecord, source: { ...packetRecord.source, requestId: bindRequest ? requestId : packetRecord.source.requestId,
    specRevision: 1, instructionSha256: workstreamInstructionDigest(workstream) } };
  const packets = createTaskPacketStore(workspaceId, "project-1", "cto-1", "workstream-1", state);
  await packets.publish({ expectedBaseRevisionId: null, revision: { projectId: "project-1", ctoId: "cto-1", workstreamId: "workstream-1",
    revisionId: "packet-board-1", packets: [row] } });
  const deliveries = createCtoDeliveryStore(workspaceId, "project-1", "cto-1", state);
  await deliveries.publish({ expectedBaseRevisionId: null, revision: { schemaVersion: 1, workspaceId, projectId: "project-1", ctoId: "cto-1",
    revisionId: "delivery-1", requestId, boardRevisionId: "workstream-board-1", instruction: workstream,
    requestedBy: { agentId: actorId, sessionId, runId: taskRunId, selectionRevision: 1 },
    executionPolicy: { mode: "plugin-tools-only-v1", toolNames: ["builder.acknowledge-workstream", "builder.read-cto-workstream"] },
    createdAt: "2026-11-04T00:00:00.000Z", phase: "submitted", runId: "66666666-6666-4666-8666-666666666666",
    cancellationRequested: false, termination: "not_applicable", outputState: "not_ready", answer: null } });
  return { state, row };
}

const scope = { workspaceId, projectId: "project-1", ctoId: "cto-1", workstreamId: "workstream-1", taskId: "task-1", taskRevision: 3 };
const attemptRequestId = "77777777-7777-4777-8777-777777777777";
const attemptSessionId = "88888888-8888-4888-8888-888888888888";
const attemptRunId = "admitted-run-1";
const authority = { readCurrent: async () => ({ sourceRevision: source, companyId: workspaceId, pluginKey: "builder", subjectKey: "task-1" }) };
const core = { agents: { sessions: { getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
  ({ requestId, state: "submitted" as const, runId: attemptRunId }) } } };
const artifact: PluginSpsArtifact = { id: "artifact-1", companyId: workspaceId, pluginKey: "builder", subjectKey: "task-1", runId: attemptRunId,
  title: "Run output", kind: "test-result", referenceUrl: null, summary: null, data: {}, createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" };
const artifactClient = (rows: PluginSpsArtifact[] = [artifact]) => ({ artifacts: { list: async () => rows } }) as unknown as PluginSpsClient;

test("planning journals fail closed on corrupt and cross-workspace state, request mismatch, dependencies, and provider failure", async () => {
  const { state } = await publishedState();
  const lookup = { ...scope, state };
  const linkageOnly = await readPlanningJournalLinkage(lookup);
  assert.equal(linkageOnly.status, "matched");
  assert.equal(linkageOnly.hostOrigin, "not-established");
  assert.equal(linkageOnly.authority, "not-established");
  await assert.rejects(readPersistedPlanningRecords({ ...lookup, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));

  const corruptState = { ...state, get: async (key: { stateKey: string }) => key.stateKey.startsWith("task-packets-head.v1.")
    ? { revisionId: "missing-entry", sequence: 1, digest: "a".repeat(64) } : state.get(key) };
  await assert.rejects(readPersistedPlanningRecords({ ...scope, state: corruptState }));
  await assert.rejects(readPersistedPlanningRecords({ ...scope, state: { ...state, get: async () => { throw new Error("offline"); } } }));

  const wrongRequest = { ...packet, source: { ...packet.source, requestId: "99999999-9999-4999-8999-999999999999" } };
  const mismatchState = await publishedState(wrongRequest, false);
  assert.equal((await readPersistedPlanningRecords({ ...scope, state: mismatchState.state })).status, "mismatched");

  const dependencyState = memoryState();
  const packets = createTaskPacketStore(workspaceId, "project-1", "cto-1", "workstream-1", dependencyState);
  const parent = { ...packet, source: { ...packet.source, requestId: ctoDeliveryRequestId(workspaceId, "project-1", "cto-1", workstream),
    instructionSha256: workstreamInstructionDigest(workstream) } };
  const child: TaskPacketRecord = { ...parent, packet: { ...parent.packet, taskId: "task-2", revision: 1, dependencies: ["task-1"] },
    dependencyPins: [{ taskId: "task-1", revision: 3, recordSha256: "f".repeat(64) }] };
  await assert.rejects(packets.publish({ expectedBaseRevisionId: null, revision: { projectId: "project-1", ctoId: "cto-1",
    workstreamId: "workstream-1", revisionId: "dependency-mismatch", packets: [parent, child] } }), /dependency pin/u);
});

test("receipt producer stores only a confirmed returned admission and current matching artifacts", async () => {
  const { state, row } = await publishedState();
  const client = artifactClient();
  const producer = createDeliveryAttemptProducer();
  const host = { state, agents: { sessions: { getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
    ({ requestId, state: "submitted" as const, runId: attemptRunId }) } } };
  const attempt = await producer.record({ ...scope, packet: row, returnedRunId: attemptRunId,
    dispatchRequestId: attemptRequestId, dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" }, authority, host, client);
  assert.deepEqual(attempt.artifactIds, ["artifact-1"]);
  assert.equal(attempt.planningRequestId, row.source.requestId);
  assert.equal(attempt.requestId, attemptRequestId);

  const nextRunId = "admitted-run-2";
  await producer.record({ ...scope, packet: row, returnedRunId: nextRunId,
    dispatchRequestId: "99999999-9999-4999-8999-999999999999", dispatchSessionId: attemptSessionId,
    recordedAtISO: "2026-11-04T03:01:00.000Z" }, authority,
  { state, agents: { sessions: { getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
    ({ requestId, state: "submitted" as const, runId: nextRunId }) } } }, artifactClient([]));
  const history = await listDeliveryAttempts(scope, state);
  assert.deepEqual(history.attempts.map(item => item.runId), [nextRunId, attemptRunId]);
  assert.equal(history.hasMore, false);

  const read = await readCurrentDeliveryAttempt({ ...scope, attemptId: attemptRunId }, host, authority, client);
  assert.equal(read.status, "observed");
  assert.equal(read.evidenceAuthority, "unknown");
  const revoked = await readCurrentDeliveryAttempt({ ...scope, attemptId: attemptRunId }, host,
    { readCurrent: async () => { throw new Error("revoked"); } }, client);
  assert.equal(revoked.status, "unknown");
  assert.equal(revoked.reason, "provider-error");
  const missingAuthority = await readCurrentDeliveryAttempt({ ...scope, attemptId: attemptRunId }, host,
    { readCurrent: async () => null }, client);
  assert.equal(missingAuthority.status, "unknown");
  assert.equal(missingAuthority.evidenceAuthority, "unknown");
});

test("uncertain admission, artifact failure, and receipt CAS conflict never replay dispatch", async () => {
  const { state, row } = await publishedState();
  const producer = createDeliveryAttemptProducer();
  const input = { ...scope, packet: row, returnedRunId: attemptRunId, dispatchRequestId: attemptRequestId,
    dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" };
  await assert.rejects(producer.record(input, authority,
    { state, agents: { sessions: { getRequest: async () => ({ requestId: attemptRequestId, state: "uncertain" as const, runId: null }) } } }, artifactClient()), /Core admission/u);
  await assert.rejects(producer.record(input, authority, { state, agents: core.agents },
    { artifacts: { list: async () => { throw new Error("artifact provider failed"); } } } as unknown as PluginSpsClient), /artifact provider failed/u);

  const noHeadCommit = { ...state, compareAndSet: async (key: { stateKey: string }, expected: unknown, value: JsonValue) => {
    if (key.stateKey.startsWith("delivery-attempts-head.v1.")) return { swapped: false };
    return state.compareAndSet(key, expected as { exists: false } | { exists: true; value: JsonValue }, value);
  } };
  await assert.rejects(createDeliveryAttemptProducer().record({ ...input, returnedRunId: "cas-conflict" }, authority,
    { state: noHeadCommit, agents: { sessions: { getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
      ({ requestId, state: "submitted" as const, runId: "cas-conflict" }) } } }, artifactClient()), /concurrently/u);
});
