import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "@sonparkserver/plugin-sdk/platform";
import type { PluginSpsArtifact, PluginSpsClient } from "@sonparkserver/plugin-sdk/runtime";
import { createCtoDeliveryStore, workstreamInstructionDigest } from "../cto-delivery-store.ts";
import { ctoDeliveryRequestId } from "../domain/cto-deliveries.ts";
import { createTaskPacketStore } from "../task-packet-tools.ts";
import type { TaskPacketRecord } from "../domain/task-packets.ts";
import type { WorkstreamRecord } from "../domain/workstreams.ts";
import { createDeliveryAttemptProducer, listDeliveryAttempts, readCurrentDeliveryAttempt, readLatestCurrentDeliveryAttempt } from "./receipt-store.ts";
import { readPersistedPlanningRecords } from "./index.ts";
import { readPlanningJournalLinkage } from "./receipt-store.ts";
import { prepareCurrentDeliveryEvidence } from "./current-preparation.ts";

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
  const latestHost = { state, agents: { sessions: { getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
    ({ requestId, state: "submitted" as const, runId: nextRunId }) } } };
  const latest = await readLatestCurrentDeliveryAttempt(scope, latestHost, authority, artifactClient([]));
  assert.equal(latest.status, "observed");
  assert.equal(latest.attempt?.runId, nextRunId);

  const read = await readCurrentDeliveryAttempt({ ...scope, attemptId: attemptRunId }, host, authority, client);
  assert.equal(read.status, "stale");
  assert.equal(read.reason, "planning-changed");
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

test("current delivery preparation preserves UNKNOWN when contract, documentation and QA providers are absent", async () => {
  const { state, row } = await publishedState();
  const runId = "prepared-current-run";
  const producer = createDeliveryAttemptProducer();
  const runHost = { state, agents: { sessions: {
    getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
      ({ requestId, state: "submitted" as const, runId }),
    getRun: async (_sessionId: string, _companyId: string, requestedRunId: string) => ({ runId: requestedRunId,
      status: "running", cancellationRequested: false, termination: "pending" as const, errorCode: null, error: null }),
  } } };
  await producer.record({ ...scope, packet: row, returnedRunId: runId, dispatchRequestId: attemptRequestId,
    dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" }, authority, runHost, artifactClient([]));

  const result = await prepareCurrentDeliveryEvidence({ ...scope, state }, {
    authority, platform: runHost, artifacts: { artifacts: { list: async () => [] } } as unknown as PluginSpsClient,
  });
  assert.equal(result.status, "matched");
  assert.equal(result.sourceRevisionVerification, "unknown");
  assert.equal(result.attempt.status, "observed");
  assert.equal(result.execution?.executionOutcome, "not-run");
  assert.equal(result.contract, "unknown");
  assert.equal(result.documentation, "unknown");
  assert.equal(result.manifest?.contract.authority, "unknown");
  assert.deepEqual(result.manifest?.deliverables, []);
  assert.equal(result.manifest?.qa.status, "not-run");
  assert.equal(result.manifest?.readiness.status, "unknown");
  assert.deepEqual(result.manifest?.instructions.knownLimits, []);

  const confirmedMissing = await prepareCurrentDeliveryEvidence({ ...scope, state }, {
    authority, platform: runHost, artifacts: { artifacts: { list: async () => [] } } as unknown as PluginSpsClient,
    readCurrentContract: async () => ({ status: "missing" }),
  });
  assert.equal(confirmedMissing.contract, "missing");
  assert.equal(confirmedMissing.manifest?.contract.authority, "missing");
});

test("current preparation reports UNKNOWN when a final re-read fails, then recovers as a read match", async () => {
  const { state, row } = await publishedState();
  const runId = "prepared-recovery-run";
  const host = { state, agents: { sessions: {
    getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
      ({ requestId, state: "submitted" as const, runId }),
    getRun: async (_sessionId: string, _companyId: string, requestedRunId: string) => ({ runId: requestedRunId,
      status: "running", cancellationRequested: false, termination: "pending" as const, errorCode: null, error: null }),
  } } };
  await createDeliveryAttemptProducer().record({ ...scope, packet: row, returnedRunId: runId,
    dispatchRequestId: attemptRequestId, dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" },
  authority, host, artifactClient([]));

  let authorityReads = 0;
  let failPreparationRecheck = true;
  const transientAuthority = { readCurrent: async () => {
    authorityReads += 1;
    // Preparation does its initial authority read, then the receipt reader's
    // two checks, then its final independent preparation re-read.
    if (authorityReads === 4 && failPreparationRecheck) {
      failPreparationRecheck = false;
      throw new Error("temporary authority provider failure");
    }
    return authority.readCurrent();
  } };
  const input = { ...scope, state };
  const providers = { authority: transientAuthority, platform: host,
    artifacts: { artifacts: { list: async () => [] } } as unknown as PluginSpsClient };
  const first = await prepareCurrentDeliveryEvidence(input, providers);
  assert.equal(first.status, "unknown");
  assert.equal(first.attempt.status, "unknown");
  assert.equal(first.contract, "unknown");
  assert.equal(first.documentation, "unknown");
  assert.equal(first.execution, null);
  assert.equal(first.manifest, null);

  const recovered = await prepareCurrentDeliveryEvidence(input, providers);
  assert.equal(recovered.status, "matched");
  assert.equal(recovered.attempt.status, "observed");
  assert.equal(recovered.sourceRevisionVerification, "unknown");
});

test("a changed contract is a contract mismatch and does not relabel the receipt as planning-changed", async () => {
  const { state, row } = await publishedState();
  const runId = "prepared-contract-change-run";
  const host = { state, agents: { sessions: {
    getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
      ({ requestId, state: "submitted" as const, runId }),
    getRun: async (_sessionId: string, _companyId: string, requestedRunId: string) => ({ runId: requestedRunId,
      status: "running", cancellationRequested: false, termination: "pending" as const, errorCode: null, error: null }),
  } } };
  await createDeliveryAttemptProducer().record({ ...scope, packet: row, returnedRunId: runId,
    dispatchRequestId: attemptRequestId, dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" },
  authority, host, artifactClient([]));

  let contractReads = 0;
  const result = await prepareCurrentDeliveryEvidence({ ...scope, state }, {
    authority, platform: host, artifacts: { artifacts: { list: async () => [] } } as unknown as PluginSpsClient,
    readCurrentContract: async ({ sourceRevision }) => {
      contractReads += 1;
      return contractReads === 1
        ? { status: "found", authority: "approved", sourceRevision,
          contract: { reference: "contract-v1", authority: "approved", requirements: [] } }
        : { status: "missing" };
    },
  });
  assert.equal(result.status, "mismatched");
  assert.deepEqual(result.mismatchSources, ["contract"]);
  assert.equal(result.attempt.status, "observed");
  assert.equal(result.attempt.reason, "current");
  assert.equal(result.manifest, null);

  let failingContractReads = 0;
  const unavailable = await prepareCurrentDeliveryEvidence({ ...scope, state }, {
    authority, platform: host, artifacts: { artifacts: { list: async () => [] } } as unknown as PluginSpsClient,
    readCurrentContract: async ({ sourceRevision }) => {
      failingContractReads += 1;
      if (failingContractReads === 2) throw new Error("temporary contract provider failure");
      return { status: "found", authority: "approved", sourceRevision,
        contract: { reference: "contract-v1", authority: "approved", requirements: [] } };
    },
  });
  assert.equal(unavailable.status, "unknown");
  assert.deepEqual(unavailable.mismatchSources, []);
  assert.equal(unavailable.attempt.status, "unknown");
  assert.equal(unavailable.attempt.reason, "provider-error");
});

test("current receipt read rechecks planning and authority after asynchronous admission and artifact reads", async () => {
  const { state, row } = await publishedState();
  const host = { state, agents: { sessions: { getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
    ({ requestId, state: "submitted" as const, runId: attemptRunId }) } } };
  await createDeliveryAttemptProducer().record({ ...scope, packet: row, returnedRunId: attemptRunId,
    dispatchRequestId: attemptRequestId, dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" }, authority, host, artifactClient([]));

  let changedPlanning = false;
  const mutatingArtifacts = { artifacts: { list: async () => {
    if (!changedPlanning) {
      changedPlanning = true;
      const packets = createTaskPacketStore(workspaceId, "project-1", "cto-1", "workstream-1", state);
      const changedRow = { ...row, packet: { ...row.packet, title: "Changed during receipt read" } };
      await packets.publish({ expectedBaseRevisionId: "packet-board-1", revision: { projectId: "project-1", ctoId: "cto-1",
        workstreamId: "workstream-1", revisionId: "packet-board-2", packets: [changedRow] } });
    }
    return [];
  } } } as unknown as PluginSpsClient;
  const stalePlanning = await readCurrentDeliveryAttempt({ ...scope, attemptId: attemptRunId }, host, authority, mutatingArtifacts);
  assert.equal(stalePlanning.status, "stale");
  assert.equal(stalePlanning.reason, "planning-changed");

  const { state: revokeState, row: revokeRow } = await publishedState();
  const revokeHost = { ...host, state: revokeState };
  await createDeliveryAttemptProducer().record({ ...scope, packet: revokeRow, returnedRunId: attemptRunId,
    dispatchRequestId: attemptRequestId, dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" }, authority, revokeHost, artifactClient([]));
  let revoked = false;
  const revocableAuthority = { readCurrent: async () => revoked ? null : await authority.readCurrent() };
  const revokingArtifacts = { artifacts: { list: async () => { revoked = true; return []; } } } as unknown as PluginSpsClient;
  const staleAuthority = await readCurrentDeliveryAttempt({ ...scope, attemptId: attemptRunId }, revokeHost, revocableAuthority, revokingArtifacts);
  assert.equal(staleAuthority.status, "stale");
  assert.equal(staleAuthority.reason, "authority-revoked");
});

test("current preparation rejects a receipt superseded during execution lookup", async () => {
  const { state, row } = await publishedState();
  let newerRunRecorded = false;
  const newerRunId = "prepared-newer-run";
  const newerRequestId = "99999999-9999-4999-8999-999999999999";
  const host = { state, agents: { sessions: {
    getRequest: async (_sessionId: string, _companyId: string, requestId: string) => ({ requestId,
      state: "submitted" as const, runId: requestId === newerRequestId ? newerRunId : attemptRunId }),
    getRun: async (_sessionId: string, _companyId: string, requestedRunId: string) => {
      if (!newerRunRecorded) {
        newerRunRecorded = true;
        await createDeliveryAttemptProducer().record({ ...scope, packet: row, returnedRunId: newerRunId,
          dispatchRequestId: newerRequestId, dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:01:00.000Z" },
        authority, host, artifactClient([]));
      }
      return { runId: requestedRunId, status: "running", cancellationRequested: false,
        termination: "pending" as const, errorCode: null, error: null };
    },
  } } };
  await createDeliveryAttemptProducer().record({ ...scope, packet: row, returnedRunId: attemptRunId,
    dispatchRequestId: attemptRequestId, dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" },
  authority, host, artifactClient([]));

  const result = await prepareCurrentDeliveryEvidence({ ...scope, state }, {
    authority, platform: host, artifacts: { artifacts: { list: async () => [] } } as unknown as PluginSpsClient,
  });
  assert.equal(result.status, "mismatched");
  assert.deepEqual(result.mismatchSources, ["attempt"]);
  assert.equal(result.attempt.status, "observed");
  assert.equal(result.attempt.reason, "current");
  assert.equal(result.execution, null);
  assert.equal(result.manifest, null);
});

test("failed current receipt read recovers on a later provider read", async () => {
  const { state, row } = await publishedState();
  const host = { state, agents: { sessions: { getRequest: async (_sessionId: string, _companyId: string, requestId: string) =>
    ({ requestId, state: "submitted" as const, runId: attemptRunId }) } } };
  await createDeliveryAttemptProducer().record({ ...scope, packet: row, returnedRunId: attemptRunId,
    dispatchRequestId: attemptRequestId, dispatchSessionId: attemptSessionId, recordedAtISO: "2026-11-04T03:00:00.000Z" }, authority, host, artifactClient([]));
  let fail = true;
  const recoveringArtifacts = { artifacts: { list: async () => {
    if (fail) { fail = false; throw new Error("temporary artifact provider failure"); }
    return [];
  } } } as unknown as PluginSpsClient;
  const request = { ...scope, attemptId: attemptRunId };
  const first = await readCurrentDeliveryAttempt(request, host, authority, recoveringArtifacts);
  assert.equal(first.status, "unknown");
  assert.equal(first.reason, "provider-error");
  const recovered = await readCurrentDeliveryAttempt(request, host, authority, recoveringArtifacts);
  assert.equal(recovered.status, "observed");
  assert.equal(recovered.reason, "current");
});
