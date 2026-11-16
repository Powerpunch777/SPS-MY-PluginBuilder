import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import type { WorkstreamRecord } from "../src/domain/workstreams.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import type { SpecCoverageResult } from "../src/spec-coverage/evaluator.ts";
import { createWorkstreamVerificationProducer, type BaselineBodyReader, type GateProofScope, type GateRuntimeProof, type GateSourceInventory } from "../src/builder-gates/workstream-verification.ts";
import type { BaselineBodyRead } from "../src/project-documents/baseline-body-source.ts";
import { createWorkstreamVerificationPublication, WORKSTREAM_VERIFIED_EVENT,
  WORKSTREAM_VERIFIED_JOB } from "../src/builder-gates/workstream-verification-publication.ts";
import { consumeVerifiedWorkstream, type ManagerDispatchRequest } from "../src/builder-gates/workstream-verification-consumer.ts";
import type { RevisionState, RevisionJobWake } from "../src/solution-revision-store.ts";
import { recordTaskQaRunReference } from "../src/task-qa-run-references.ts";
import { parseTaskQaReport, taskQaCriteria } from "../src/task-qa-reports.ts";
import type { GateProtectedTaskQaProof } from "../src/builder-gates/workstream-verification.ts";
import { qaCarryForwardPin, type QaCarryForward } from "../src/builder-gates/qa-carry-forward.ts";

const scope: GateProofScope = {
  workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "project-1", workstreamId: "ws-1", taskId: "task-1",
};
const ctoId = "cto-1";
const taskRecord = {
  packet: {
    projectId: scope.projectId, ctoId, workstreamId: scope.workstreamId, taskId: scope.taskId, revision: 1,
    kind: "development" as const, title: "Implement", goal: "Implement scoped feature", scopeNodeIds: ["node-1"],
    requirementIds: ["req-1"], dependencies: [], included: ["feature"], excluded: [], constraints: [],
    acceptance: ["passes"], evidenceRequired: ["runtime report"], reuse: [],
    testPlan: { environment: "Node", steps: ["run"], expectedResults: ["pass"], passCriteria: ["all tests pass"] },
  },
  source: { requestId: "22222222-2222-4222-8222-222222222222", workstreamId: scope.workstreamId,
    specRevision: 1, instructionSha256: "a".repeat(64) },
  author: { agentId: "33333333-3333-4333-8333-333333333333", sessionId: "44444444-4444-4444-8444-444444444444",
    runId: "55555555-5555-4555-8555-555555555555" },
  createdAtISO: "2026-11-06T00:00:00.000Z", dependencyPins: [],
};
const workstream = {
  spec: { projectId: scope.projectId, id: scope.workstreamId, revision: 1, sourceSpecRevisionId: "spec-r1",
    assignedCtoId: ctoId, scopeNodeIds: ["node-1"], title: "Workstream", goal: "Implement scoped feature",
    included: ["feature"], excluded: [], dependencies: [], interfaceContracts: [], technologyDecisionsRef: "tech-1",
    reuseCandidates: [], acceptance: ["passes"], evidenceRequired: ["exact QA"], openQuestions: [] },
  sourceBaselineRevisionId: "base-1", baselineDigest: "1".repeat(64),
  technologyDigest: "2".repeat(64), ctoAgentId: taskRecord.author.agentId, ctoSessionId: taskRecord.author.sessionId,
  author: { ...taskRecord.author, selectionRevision: 1 }, createdAt: taskRecord.createdAtISO,
  change: { previousRevision: null, reason: "Initial", diff: "Create", impactNodeIds: ["node-1"],
    impactInterfaceContracts: [], impactTaskIds: [], effectiveFrom: "After receipt" }, receipt: null,
} satisfies WorkstreamRecord;
taskRecord.source.instructionSha256 = workstreamInstructionDigest(workstream);
const coverage = {
  inputIdentity: { workspaceId: scope.workspaceId, projectId: scope.projectId, specRevisionId: "spec-r1" },
  scope: { requirementIds: ["req-1"], acIds: ["ac-1"] },
  targets: [
    { targetId: "req-1", targetKind: "requirement", status: "COVERED" },
    { targetId: "ac-1", targetKind: "ac", status: "COVERED" },
  ], unknowns: [],
} as unknown as SpecCoverageResult;
const taskDigest = taskPacketRecordDigest(taskRecord, scope.projectId, ctoId, scope.workstreamId);
const workstreamDigest = createHash("sha256").update(JSON.stringify(workstream), "utf8").digest("hex");
const pin = (sourceId: string, revisionId: string, digest: string) => ({ sourceId, revisionId, sha256: digest });
const commitSha = "a".repeat(40);
const taskPin = pin(`builder-v1:task-packet:${scope.taskId}`, "task-r1", taskDigest);
const workstreamPin = pin(`builder-v1:workstream:${scope.workstreamId}`, "ws-1-r1", workstreamDigest);
const approvalPin = pin("core:execution-approval:plan-1", "approval-r1", "6".repeat(64));
const commitPin = pin("builder-v1:commit", commitSha, "7".repeat(64));
const planPin = pin("core:execution-plan:plan-1", "plan-r1", "8".repeat(64));
const environmentPin = pin("core:execution-environment", "env-r1", "9".repeat(64));
const artifactPin = pin("core:runtime-artifact:run-1", "artifact-r1", "a".repeat(64));
const qaReceipt = pin("core:qa-receipt:qa-run-1", "qa-r1", "b".repeat(64));
const sourcePins = [pin("builder-v1:baseline:base-1", "base-1", "1".repeat(64)),
    pin("builder-v1:graph:graph-1", "graph-1", "2".repeat(64)),
    workstreamPin, taskPin, approvalPin, commitPin, planPin, environmentPin, artifactPin, qaReceipt];
const baselineBody = "# Published Builder Baseline";
const baselineBodySha256 = createHash("sha256").update(baselineBody, "utf8").digest("hex");
const baselineDocument = {
  schemaVersion: 1, workspaceId: scope.workspaceId, projectId: scope.projectId,
  documentId: "baseline-body:doc-1", documentRevisionId: "document-r1", createdAt: "2026-11-06T00:00:00.000Z",
  sourceBaselineRevisionId: "base-1", sourceBaselineSequence: 1, sourceBaselineSha256: "1".repeat(64),
  body: baselineBody, bodySha256: baselineBodySha256,
  sourcePins: [
    { kind: "baseline", id: `${scope.workspaceId}/${scope.projectId}`, revisionId: "base-1", sha256: "1".repeat(64) },
    { kind: "specification", id: `${scope.workspaceId}/${scope.projectId}`, revisionId: "spec-r1", sha256: "2".repeat(64) },
    { kind: "graph", id: `${scope.workspaceId}/${scope.projectId}`, revisionId: "graph-1", sha256: "3".repeat(64) },
    { kind: "draft", id: `${scope.workspaceId}/${scope.projectId}`, revisionId: "draft-1", sha256: "4".repeat(64) },
    { kind: "user-source", id: "lead-turn:source", revisionId: "lead-turn:source", sha256: "5".repeat(64) },
  ], inventory: { status: "partial", reason: "Host full inventory unavailable." },
  historicalApproval: { status: "unknown", reason: "Historical approval is not established." },
};
const baselineBodyReader: BaselineBodyReader = {
  async read(documentRevisionId) {
    if (documentRevisionId !== baselineDocument.documentRevisionId) return {
      status: "unavailable", reason: "revision-not-found", document: null, source: "unknown",
      currentBaselineRevisionId: "base-1", bodyAvailable: false, historicalApproval: null,
    };
    return { status: "available", reason: null, document: baselineDocument as unknown as BaselineBodyRead["document"],
      source: "current", currentBaselineRevisionId: "base-1", bodyAvailable: true,
      historicalApproval: { status: "unknown", reason: "Historical approval is not established." } };
  },
};
// TEST_FIXTURE_ONLY: these immutable pins/proofs model the future trusted Host-reader contract; none are runtime or approval facts.
const inventory: GateSourceInventory = {
  provenance: { adapter: "builder.workstream-source-inventory.v1", operation: "readCurrent" }, scope, complete: true,
  pins: sourcePins,
  heads: sourcePins.map((item, index) => ({ sourceId: item.sourceId, revisionId: item.revisionId, sequence: index + 1, digest: item.sha256 })),
};
const runtimeProof: GateRuntimeProof = {
  provenance: { adapter: "builder.workstream-runtime-proof.v1", operation: "readCompletedRun" }, scope,
  runId: "run-1", taskRecordSha256: taskDigest, status: "passed", commitSha,
  execution: { planId: "plan-1", taskRevision: 1, workstreamRevision: 1,
    commitPin, planPin, environmentPin, artifactPin },
  independentQa: { status: "passed", verifier: { agentId: "66666666-6666-4666-8666-666666666666",
    sessionId: "77777777-7777-4777-8777-777777777777" }, runId: "qa-run-1", receipt: qaReceipt,
    acceptedPins: { task: taskPin, workstream: workstreamPin, approval: approvalPin,
      commit: commitPin, plan: planPin, environment: environmentPin, artifact: artifactPin } },
  report: qaReceipt,
};
const request = { eventId: "event-1", scope, ctoId,
  baselineRef: { documentId: baselineDocument.documentId, documentRevisionId: baselineDocument.documentRevisionId, bodySha256: baselineBodySha256 },
  workstream, taskRecord, coverage };
const readers = {
  sourceInventory: async () => ({ status: "available" as const, value: inventory }),
  runtimeProof: async () => ({ status: "available" as const, value: runtimeProof }),
  baselineBodySource: baselineBodyReader,
};

async function protectedProofFixture() {
  // TEST_FIXTURE_ONLY: validates Gate composition, not a real Core run or AI QA.
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  const values = new Map<string, JsonValue>();
  const state: RevisionState = { async get(key) { return values.get(key.stateKey) ?? null; },
    async compareAndSet(key, expected, value) {
      const current = values.get(key.stateKey) ?? null;
      const swapped = expected.exists ? JSON.stringify(current) === JSON.stringify(expected.value) : current === null;
      if (swapped) values.set(key.stateKey, structuredClone(value));
      return { swapped };
    } };
  const source = { sourceId: "88888888-8888-4888-8888-888888888888", folderKey: "project-source", branch: "task/one",
    expectedHead: "d".repeat(40), readPaths: ["src", "test"], writePaths: ["src"], qaWritePaths: [] as string[] };
  const development = { ...structuredClone(taskRecord), packet: { ...structuredClone(taskRecord.packet), sourceAccess: source } };
  const developmentDigest = taskPacketRecordDigest(development, scope.projectId, ctoId, scope.workstreamId);
  const qaRecord = { ...structuredClone(taskRecord), packet: { ...structuredClone(taskRecord.packet), taskId: "qa-1",
    kind: "qa" as const, dependencies: [scope.taskId], sourceAccess: { ...source, writePaths: [], qaWritePaths: ["test"] }, acceptance: ["Independently checked behavior"] },
  dependencyPins: [{ taskId: scope.taskId, revision: 1, recordSha256: developmentDigest }] };
  const qaDigest = taskPacketRecordDigest(qaRecord, scope.projectId, ctoId, scope.workstreamId);
  const qaWorker = { agentId: "66666666-6666-4666-8666-666666666666", sessionId: "77777777-7777-4777-8777-777777777777" };
  const coreRunId = "99999999-9999-4999-8999-999999999999", authorRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const subjectKey = "test-protected-qa-subject";
  const recorded = await recordTaskQaRunReference(state, { ...scope, ctoId, implementation: development,
    implementationDigest: developmentDigest, qa: qaRecord, qaDigest, qaWorker,
    source: { sourceId: source.sourceId, folderKey: source.folderKey, branch: source.branch },
    commitSha, treeSha: "c".repeat(40), acceptanceId: "4".repeat(64), submissionId: "5".repeat(64),
    approvalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", planSha256: "6".repeat(64), requestId: "test-request-1", subjectKey,
    subjectKeySha256: createHash("sha256").update(subjectKey).digest("hex"), async assertCurrent() {} }, coreRunId);
  if (!("reference" in recorded) || !recorded.reference) throw new Error("Missing fixture run reference.");
  const reference = recorded.reference;
  const body = { schemaVersion: 1 as const, reference, coreReceiptDigest: "7".repeat(64), coreStatus: "succeeded" as const,
    author: { ...qaWorker, runId: authorRunId }, checks: taskQaCriteria(qaRecord.packet.acceptance,
      qaRecord.packet.testPlan.passCriteria, development.packet.acceptance).map(criterion => ({ ...criterion,
        verdict: "passed" as const, note: "Fixture independently assessed criterion." })),
    summary: "Fixture QA report.", verdict: "passed" as const };
  const report = parseTaskQaReport({ ...body, revisionId: `task-qa-report-v1:${hash(body)}` });
  const proof: GateProtectedTaskQaProof = { provenance: { adapter: "builder.protected-task-qa-proof.v1", operation: "readCurrent" },
    scope, status: "passed", taskRecordSha256: developmentDigest, qaRecord, report,
    authorRun: { runId: authorRunId, status: "succeeded", cancellationRequested: false },
    runPin: pin(`core:protected-test-run:${coreRunId}`, coreRunId, "8".repeat(64)),
    receiptPin: pin(`core:protected-test-receipt:${coreRunId}`, report.coreReceiptDigest, report.coreReceiptDigest),
    referencePin: pin("builder-v1:task-qa-run:qa-1", reference.revisionId, hash(reference)),
    reportPin: pin("builder-v1:task-qa-report:qa-1", report.revisionId, hash(report)) };
  const pins = [sourcePins[0]!, sourcePins[1]!, workstreamPin,
    pin(`builder-v1:task-packet:${scope.taskId}`, "task-r1", developmentDigest),
    pin("builder-v1:task-packet:qa-1", "qa-r1", qaDigest), proof.runPin, proof.receiptPin, proof.referencePin, proof.reportPin];
  const current: GateSourceInventory = { ...inventory, pins,
    heads: pins.map(item => ({ sourceId: item.sourceId, revisionId: item.revisionId, digest: item.sha256, sequence: 1 })) };
  const verify = (candidate: GateProtectedTaskQaProof) => createWorkstreamVerificationProducer({
    ...readers, sourceInventory: async () => ({ status: "available", value: current }),
    runtimeProof: async () => ({ status: "available", value: candidate }),
  }).verify({ ...request, taskRecord: development });
  return { proof, verify, development, inventory: current };
}

test("protected execution and a completed independent Builder QA report establish G6 without fictional Core QA or artifact IDs", async () => {
  const f = await protectedProofFixture();
  const result = await f.verify(f.proof);
  assert.equal(result.status, "VERIFIED", JSON.stringify(result));
  assert.equal(result.snapshot!.qaEvidence[0]!.report.sourceId, "builder-v1:task-qa-report:qa-1");
  assert.ok(result.snapshot!.gateDecisions.find(gate => gate.gateId === "G6")!.evidenceRefs
    .some(ref => ref.sourceId.startsWith("core:protected-test-receipt:")));
  assert.ok(result.snapshot!.sourcePins.every(ref => !ref.sourceId.startsWith("core:qa-receipt:")
    && !ref.sourceId.startsWith("core:runtime-artifact:")));
});

test("protected Gate evidence rejects unfinished authors, wrong receipt, changed source and missing criteria", async () => {
  const f = await protectedProofFixture();
  const candidates = [
    { ...f.proof, authorRun: { ...f.proof.authorRun, status: "running" } },
    { ...f.proof, receiptPin: { ...f.proof.receiptPin, sha256: "0".repeat(64) } },
    { ...f.proof, taskRecordSha256: "0".repeat(64) },
    { ...f.proof, report: { ...f.proof.report, checks: f.proof.report.checks.slice(1) } },
  ];
  for (const candidate of candidates) assert.equal((await f.verify(candidate as GateProtectedTaskQaProof)).status, "UNKNOWN");
});

async function carriedProofFixture() {
  // TEST_FIXTURE_ONLY: exercises the Gate's trusted-reader shape, not G5 authority.
  const f = await protectedProofFixture();
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const nextWorkstream: WorkstreamRecord = { ...workstream, spec: { ...workstream.spec, revision: 3 },
    change: { ...workstream.change, previousRevision: 2, g5Handoff: {
      oldBaselineRevisionId: "base-old", newBaselineRevisionId: "base-1", oldUiRevisionId: "ui-old", newUiRevisionId: "ui-new",
      technology: null, workstreams: { oldRevisionId: "ws-old", newRevisionId: "ws-compared" },
      tasks: { ctoId, workstreamId: scope.workstreamId, oldRevisionId: "tasks-old", newRevisionId: "tasks-compared" },
      workstreamImpactStatus: "CANDIDATES", taskImpactStatus: "NO_CANDIDATE_OBSERVED", affectedTaskIds: [], impactSha256: "d".repeat(64),
    } } };
  const source = { ...f.development.source, specRevision: 3, instructionSha256: workstreamInstructionDigest(nextWorkstream) };
  const development = { ...f.development, source, packet: { ...f.development.packet, revision: 3 } };
  const developmentDigest = taskPacketRecordDigest(development, scope.projectId, ctoId, scope.workstreamId);
  const qaRecord = { ...f.proof.qaRecord, source, packet: { ...f.proof.qaRecord.packet, revision: 3 },
    dependencyPins: [{ taskId: scope.taskId, revision: 3, recordSha256: developmentDigest }] };
  const qaDigest = taskPacketRecordDigest(qaRecord, scope.projectId, ctoId, scope.workstreamId);
  const carry: QaCarryForward = { kind: "g5-task-qa-carry-forward-v1", taskId: scope.taskId, qaTaskId: qaRecord.packet.taskId,
    handoffSha256: hash(nextWorkstream.change.g5Handoff), priorTaskBoardRevisionId: "tasks-old",
    comparedTaskBoardRevisionId: "tasks-compared", currentTaskBoardRevisionId: "tasks-current",
    task: { prior: f.proof.taskRecordSha256, compared: "b".repeat(64), current: developmentDigest, inputsSha256: "e".repeat(64) },
    qa: { prior: f.proof.report.reference.binding.qaDigest, compared: "c".repeat(64), current: qaDigest, inputsSha256: "f".repeat(64) } };
  const proof: GateProtectedTaskQaProof = { ...f.proof, taskRecordSha256: developmentDigest, qaRecord,
    carryForward: { proof: carry, implementationRecord: f.development, qaRecord: f.proof.qaRecord } };
  const carryPin = qaCarryForwardPin(carry, proof.reportPin);
  const pins = f.inventory.pins.map(item => item.sourceId === workstreamPin.sourceId
    ? pin(item.sourceId, "ws-current", hash(nextWorkstream)) : item.sourceId === taskPin.sourceId
    ? pin(item.sourceId, "task-current", developmentDigest) : item.sourceId === "builder-v1:task-packet:qa-1"
    ? pin(item.sourceId, "qa-current", qaDigest) : item).concat(carryPin);
  const current: GateSourceInventory = { ...f.inventory, pins,
    heads: pins.map(item => ({ sourceId: item.sourceId, revisionId: item.revisionId, digest: item.sha256, sequence: 3 })) };
  const verify = (candidate = proof, candidateInventory = current) => createWorkstreamVerificationProducer({ ...readers,
    sourceInventory: async () => ({ status: "available", value: candidateInventory }),
    runtimeProof: async () => ({ status: "available", value: candidate }),
  }).verify({ ...request, workstream: nextWorkstream, taskRecord: development });
  return { proof, current, carryPin, verify };
}

test("protected Gate preserves original QA while binding the current Task and exact carry pin", async () => {
  const f = await carriedProofFixture(), result = await f.verify();
  assert.equal(result.status, "VERIFIED", JSON.stringify(result));
  const evidence = result.snapshot!.qaEvidence[0]!;
  assert.deepEqual(evidence.carryForward, f.proof.carryForward!.proof);
  assert.equal(evidence.report.revisionId, f.proof.report.revisionId);
  assert.equal(f.proof.report.reference.binding.implementationRevision, 1);
  assert(result.snapshot!.sourcePins.some(item => item.sha256 === f.proof.taskRecordSha256));
  assert(result.snapshot!.gateDecisions.find(gate => gate.gateId === "G6")!.evidenceRefs
    .some(item => item.sourceId === f.carryPin.sourceId && item.sha256 === f.carryPin.sha256));
});

test("protected Gate rejects stale current, old assessment, handoff and missing carry pin", async () => {
  const f = await carriedProofFixture(), carry = f.proof.carryForward!;
  const variants = [
    { ...f.proof, carryForward: { ...carry, proof: { ...carry.proof, handoffSha256: "0".repeat(64) } } },
    { ...f.proof, carryForward: { ...carry, proof: { ...carry.proof, task: { ...carry.proof.task, current: "0".repeat(64) } } } },
    { ...f.proof, carryForward: { ...carry, implementationRecord: { ...carry.implementationRecord,
      packet: { ...carry.implementationRecord.packet, revision: 2 } } } },
    { ...f.proof, carryForward: undefined },
  ];
  for (const candidate of variants) assert.equal((await f.verify(candidate)).status, "UNKNOWN");
  assert.equal((await f.verify(f.proof, { ...f.current,
    pins: f.current.pins.filter(item => item.sourceId !== f.carryPin.sourceId),
    heads: f.current.heads.filter(item => item.sourceId !== f.carryPin.sourceId) })).status, "UNKNOWN");
});

function publicationFixture() {
  const sourceAddress = { scopeKind: "company" as const, scopeId: scope.workspaceId, stateKey: "fixture-source-head" };
  const key = (item: SpsStateKey) => JSON.stringify([item.scopeKind, item.scopeId, item.namespace ?? "default", item.stateKey]);
  const expectedValue = { revision: "fixture-r1" };
  const values = new Map<string, JsonValue>([[key(sourceAddress), expectedValue]]);
  const wakes: RevisionJobWake[] = [];
  let calls = 0, lostReply = false, race = false;
  const swap = (address: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
    const current = values.get(key(address));
    const ok = expected.exists ? JSON.stringify(current) === JSON.stringify(expected.value) : current === undefined;
    if (ok) values.set(key(address), structuredClone(value));
    return ok;
  };
  const drift = () => values.set(key(sourceAddress), { revision: "fixture-r2" });
  const state: RevisionState = {
    async get(address) { return structuredClone(values.get(key(address)) ?? null); },
    async compareAndSet(...args) { return { swapped: swap(...args) }; },
    async guardedCompareAndSet(address, expected, value) {
      if (address.guards.some(guard => JSON.stringify(values.get(key({ scopeKind: "company", scopeId: address.scopeId,
        stateKey: guard.stateKey, namespace: guard.namespace }))) !== JSON.stringify(guard.expectedValue))) return { status: "conflict" };
      return { status: swap(address, expected, value) ? "committed" : "conflict" };
    },
    async guardedCompareAndSetWithJobWakeV1(address, expected, value, wake) {
      calls++;
      if (race) drift();
      if (address.guards.some(guard => JSON.stringify(values.get(key({ scopeKind: "company", scopeId: address.scopeId,
        stateKey: guard.stateKey, namespace: guard.namespace }))) !== JSON.stringify(guard.expectedValue))) return { status: "conflict" };
      if (!swap(address, expected, value)) return { status: "conflict" };
      wakes.push(structuredClone(wake));
      if (lostReply) throw new Error("fixture lost acknowledgement after transaction");
      return { status: "committed" };
    },
  };
  const authority = async () => ({ status: "available" as const, inputs: [request], readers,
    taskBoard: { projectId: scope.projectId, ctoId, workstreamId: scope.workstreamId, revisionId: "task-board-1", packets: [taskRecord] },
    bindGuards: async (verified: readonly { sourcePins: readonly { sourceId: string }[] }[]) => [
      { stateKey: sourceAddress.stateKey, expectedValue, sourceIds: [...new Set(verified.flatMap(proof => proof.sourcePins.map(pin => pin.sourceId)))] },
    ] });
  return { state, wakes, values, authority, drift, get calls() { return calls; },
    loseReply() { lostReply = true; }, race() { race = true; } };
}

test("a guarded verification journal publishes a minimal durable wake and reads only the current guarded snapshot", async () => {
  const f = publicationFixture();
  const publisher = createWorkstreamVerificationPublication(f.state, f.authority);
  const result = await publisher.publish(scope);
  assert.equal(result.status, "published");
  assert.match(result.eventId!, /^builder-verified-v1:[a-f0-9]{64}$/u);
  assert.deepEqual(f.wakes, [{ name: WORKSTREAM_VERIFIED_EVENT, jobKey: WORKSTREAM_VERIFIED_JOB, eventId: result.eventId,
    payload: { schemaVersion: 1, workspaceId: scope.workspaceId, projectId: scope.projectId,
      workstreamId: scope.workstreamId, eventId: result.eventId } }]);
  const readScope = { ...scope, eventId: result.eventId! };
  const restarted = createWorkstreamVerificationPublication(f.state, f.authority);
  assert.equal((await restarted.readCurrent(readScope)).status, "current");
  assert.deepEqual(await restarted.publish(scope), { status: "existing", eventId: result.eventId });
  assert.equal(f.calls, 1);
  f.drift();
  assert.equal((await restarted.readCurrent(readScope)).status, "stale");
});

test("current effect guards include the exact publication head and all observed source guards", async () => {
  const f = publicationFixture(), publisher = createWorkstreamVerificationPublication(f.state, f.authority);
  const result = await publisher.publish(scope);
  assert.equal(result.status, "published");
  const readScope = { ...scope, eventId: result.eventId! }, before = structuredClone(f.values);
  const current = await publisher.readCurrentEffectGuards(readScope);
  assert.equal(current.status, "current");
  if (current.status !== "current") return;
  assert.equal(current.guards.length, 2);
  assert(current.guards.some(guard => guard.stateKey === "fixture-source-head"));
  const publication = current.guards.find(guard => guard.stateKey.startsWith("workstream-verification-head.v1."));
  assert(publication, JSON.stringify(current.guards));
  for (const guard of current.guards) assert.deepEqual(guard.expectedValue,
    await f.state.get({ scopeKind: "company", scopeId: scope.workspaceId, namespace: guard.namespace, stateKey: guard.stateKey }));
  assert.deepEqual(f.values, before, "guard observation writes no state or execution");
  f.drift();
  assert.equal((await publisher.readCurrentEffectGuards(readScope)).status, "stale");
});

test("additional authority-only guards need no invented content pin and still revoke the published snapshot", async () => {
  const f = publicationFixture();
  const authorityKey = JSON.stringify(["company", scope.workspaceId, "default", "fixture-cto-authority"]);
  const authorityValue = { agentRevision: 1 };
  f.values.set(authorityKey, authorityValue);
  const publisher = createWorkstreamVerificationPublication(f.state, async () => {
    const source = await f.authority();
    return { ...source, async bindGuards(verified) {
      return [...await source.bindGuards(verified), { stateKey: "fixture-cto-authority", expectedValue: authorityValue, sourceIds: [] }];
    } };
  });
  const result = await publisher.publish(scope);
  assert.equal(result.status, "published");
  if (!("eventId" in result) || !result.eventId) throw new Error("Missing published fixture verification.");
  f.values.set(authorityKey, { agentRevision: 2 });
  assert.equal((await publisher.readCurrent({ ...scope, eventId: result.eventId })).status, "stale");
  assert.equal(f.wakes.length, 1);
});

test("publication does not wake when authority, runtime proof, complete guards, or the atomic API is missing", async () => {
  const f = publicationFixture();
  const noAtom = createWorkstreamVerificationPublication({ get: f.state.get }, f.authority);
  assert.deepEqual(await noAtom.publish(scope), { status: "unknown", reason: "atomic-verification-wake-unavailable" });
  const noAuthority = createWorkstreamVerificationPublication(f.state);
  assert.equal((await noAuthority.publish(scope)).status, "unknown");
  const noRuntime = createWorkstreamVerificationPublication(f.state, async () => ({
    ...await f.authority(), readers: { ...readers, runtimeProof: undefined },
  }));
  assert.equal((await noRuntime.publish(scope)).status, "unknown");
  const missingGuards = createWorkstreamVerificationPublication(f.state, async () => ({
    ...await f.authority(), bindGuards: async () => [{ stateKey: "fixture-source-head", expectedValue: { revision: "fixture-r1" },
      sourceIds: [sourcePins[0]!.sourceId] }],
  }));
  assert.deepEqual(await missingGuards.publish(scope), { status: "unknown", reason: "atomic-source-guards-incomplete" });
  assert.equal(f.calls, 0);
  assert.equal(f.wakes.length, 0);
  assert.equal(f.values.size, 1, "no staged publication exists");
});

test("source drift between verification and atomic CAS leaves the staged verification unpublished and unwoken", async () => {
  const f = publicationFixture();
  f.race();
  const publisher = createWorkstreamVerificationPublication(f.state, f.authority);
  const result = await publisher.publish(scope);
  assert.equal(result.status, "conflict");
  assert.equal((await publisher.readCurrent({ ...scope, eventId: result.eventId! })).status, "unknown");
  assert.equal(f.calls, 1);
  assert.equal(f.wakes.length, 0);
});

test("lost acknowledgement can be reconciled by the published head without a second wake", async () => {
  const f = publicationFixture();
  f.loseReply();
  const publisher = createWorkstreamVerificationPublication(f.state, f.authority);
  const first = await publisher.publish(scope);
  assert.equal(first.status, "uncertain");
  assert.equal((await publisher.readCurrent({ ...scope, eventId: first.eventId! })).status, "current");
  assert.deepEqual(await publisher.publish(scope), { status: "existing", eventId: first.eventId });
  assert.equal(f.calls, 1);
  assert.equal(f.wakes.length, 1);
});

test("consumer uses the persisted guarded revision, not the wake payload, and does not resend on replay", async () => {
  const f = publicationFixture();
  const publisher = createWorkstreamVerificationPublication(f.state, f.authority);
  const published = await publisher.publish(scope);
  assert.equal(published.status, "published");
  const delivered = f.wakes[0]!.payload as { workspaceId: string; projectId: string; workstreamId: string; eventId: string };
  let request: ManagerDispatchRequest | undefined;
  let sends = 0;
  const manager = {
    async dispatch(input: ManagerDispatchRequest) { sends++; request = input; },
    async readReceipt(requestId: string) {
      return request?.requestId === requestId ? { status: "accepted" as const, requestId, receiptId: "receipt-1", runId: "run-1" }
        : { status: "not-found" as const, authoritative: true as const };
    },
  };
  const rejected = await consumeVerifiedWorkstream({ ...delivered, eventId: "unpublished-fixture-event" }, f.state, publisher.readCurrent, manager);
  assert.equal(rejected.status, "unknown");
  assert.equal(sends, 0);
  const accepted = await consumeVerifiedWorkstream(delivered, f.state, publisher.readCurrent, manager);
  assert.equal(accepted.status, "accepted");
  assert.equal(request?.snapshot.sourcePins.find(pin => pin.sourceId === commitPin.sourceId)?.revisionId, commitSha);
  assert.equal(request?.snapshot.qaEvidence[0]?.report.sha256, qaReceipt.sha256);
  const replay = await consumeVerifiedWorkstream(delivered, f.state, publisher.readCurrent, manager);
  assert.equal(replay.status, "accepted");
  assert.equal(sends, 1);
});

test("one passed task cannot publish VERIFIED for a Workstream containing another development task", async () => {
  const f = publicationFixture();
  const another = { ...taskRecord, packet: { ...taskRecord.packet, taskId: "task-2" } };
  const publisher = createWorkstreamVerificationPublication(f.state, async () => {
    const authority = await f.authority();
    return { ...authority, taskBoard: { ...authority.taskBoard, packets: [taskRecord, another] } };
  });
  assert.deepEqual(await publisher.publish(scope), { status: "unknown", reason: "workstream-task-inventory-incomplete" });
  assert.equal(f.wakes.length, 0);
  assert.equal(f.calls, 0);
});

test("missing Core evidence readers remains UNKNOWN and emits no consumer snapshot", async () => {
  const result = await createWorkstreamVerificationProducer({}).verify(request);
  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.reasons, ["authenticated-current-source-inventory-reader-unregistered", "core-runtime-proof-reader-unregistered", "baseline-body-source-reader-unregistered"]);
  assert.equal(result.snapshot, null);
});

test("reader errors, unavailable evidence, or unsupported provenance remains UNKNOWN", async () => {
  const unavailable = createWorkstreamVerificationProducer({
    ...readers, runtimeProof: async () => ({ status: "unknown" as const, reason: "runtime-reader-not-supported" }),
  });
  assert.equal((await unavailable.verify(request)).status, "UNKNOWN");
  const throws = createWorkstreamVerificationProducer({
    ...readers, sourceInventory: async () => { throw new Error("Host operation absent"); },
  });
  assert.equal((await throws.verify(request)).status, "UNKNOWN");
  const forgedShape = createWorkstreamVerificationProducer({
    ...readers, sourceInventory: async () => ({ status: "available" as const,
      value: { ...inventory, provenance: { adapter: "builder.workstream-source-inventory.v0", operation: "readCurrent" } } as unknown as GateSourceInventory }),
  });
  assert.equal((await forgedShape.verify(request)).status, "UNKNOWN");
});

test("TaskPacket scope, current Workstream binding, and D3 unknowns fail closed", async () => {
  const wrongWorkstream = createWorkstreamVerificationProducer(readers);
  assert.equal((await wrongWorkstream.verify({ ...request, workstream: { ...workstream,
    spec: { ...workstream.spec, assignedCtoId: "other-cto" } } })).status, "UNKNOWN");
  assert.equal((await wrongWorkstream.verify({ ...request, coverage: { ...coverage, unknowns: [{ targetId: null, targetKind: null, code: "missing-source" }] } })).status, "UNKNOWN");
  assert.equal((await wrongWorkstream.verify({ ...request, coverage: { ...coverage, targets: [null] } as unknown as SpecCoverageResult })).status, "UNKNOWN");
  assert.equal((await wrongWorkstream.verify({ ...request, taskRecord: { ...taskRecord, packet: { ...taskRecord.packet, taskId: "other-task" } } })).status, "UNKNOWN");
});

test("D3 result must cover the exact scoped requirement and AC targets without duplicates or extras", async () => {
  const producer = createWorkstreamVerificationProducer(readers);
  const invalidTargets: unknown[][] = [
    [{ targetId: "ac-unrelated", targetKind: "ac", status: "COVERED" }],
    [{ targetId: "req-1", targetKind: "requirement", status: "COVERED" }],
    [coverage.targets[0], coverage.targets[0]],
    [coverage.targets[0], { targetId: "ac-1", targetKind: "requirement", status: "COVERED" }],
    [...coverage.targets, { targetId: "extra", targetKind: "ac", status: "COVERED" }],
  ];
  for (const targets of invalidTargets) {
    assert.equal((await producer.verify({ ...request, coverage: { ...coverage, targets } as unknown as SpecCoverageResult })).status, "UNKNOWN");
  }
  assert.equal((await producer.verify({ ...request, coverage: { ...coverage,
    scope: { requirementIds: ["req-1", "req-1"], acIds: ["ac-1"] } } as unknown as typeof coverage })).status, "UNKNOWN");
});

test("cross-scope, incomplete inventory, stale task pin, or unbound QA receipt remains UNKNOWN", async () => {
  const crossScope = createWorkstreamVerificationProducer({
    ...readers, sourceInventory: async () => ({ status: "available" as const, value: { ...inventory,
      scope: { ...scope, projectId: "other-project" } } }),
  });
  assert.equal((await crossScope.verify(request)).status, "UNKNOWN");
  const incomplete = createWorkstreamVerificationProducer({
    ...readers, sourceInventory: async () => ({ status: "available" as const, value: { ...inventory, complete: false } as unknown as GateSourceInventory }),
  });
  assert.equal((await incomplete.verify(request)).status, "UNKNOWN");
  const repeatedKind = createWorkstreamVerificationProducer({
    ...readers, sourceInventory: async () => ({ status: "available" as const, value: { ...inventory,
      pins: inventory.pins.map((item, index) => index < 4 ? { ...item, sourceId: `builder-v1:baseline:${index}` } : item) } }),
  });
  assert.equal((await repeatedKind.verify(request)).status, "UNKNOWN");
  const staleTask = createWorkstreamVerificationProducer({
    ...readers, sourceInventory: async () => ({ status: "available" as const, value: { ...inventory,
      pins: inventory.pins.map((item, index) => index === 3 ? { ...item, sha256: "f".repeat(64) } : item) } }),
  });
  assert.equal((await staleTask.verify(request)).status, "UNKNOWN");
  const duplicateEvidence = createWorkstreamVerificationProducer({
    ...readers, sourceInventory: async () => ({ status: "available" as const, value: {
      ...inventory, pins: [...inventory.pins, inventory.pins.at(-1)!],
      heads: [...inventory.heads, inventory.heads.at(-1)!],
    } }),
  });
  assert.equal((await duplicateEvidence.verify(request)).status, "UNKNOWN");
  const unboundReport = createWorkstreamVerificationProducer({
    ...readers, runtimeProof: async () => ({ status: "available" as const, value: { ...runtimeProof,
      report: pin("core:qa-receipt:other", "other-rev", "5".repeat(64)) } }),
  });
  assert.equal((await unboundReport.verify(request)).status, "UNKNOWN");
});

test("runtime proof must match current commit, plan, environment, task/workstream revisions, approval and independent QA identity", async () => {
  const invalid: GateRuntimeProof[] = [
    { ...runtimeProof, commitSha: "c".repeat(40) },
    { ...runtimeProof, execution: { ...runtimeProof.execution, planId: "plan-old" } },
    { ...runtimeProof, execution: { ...runtimeProof.execution, environmentPin: pin("core:execution-environment", "env-old", "9".repeat(64)) } },
    { ...runtimeProof, execution: { ...runtimeProof.execution, taskRevision: 2 } },
    { ...runtimeProof, execution: { ...runtimeProof.execution, workstreamRevision: 2 } },
    { ...runtimeProof, execution: { ...runtimeProof.execution, artifactPin: pin("core:runtime-artifact:run-1", "artifact-old", "a".repeat(64)) } },
    { ...runtimeProof, independentQa: { ...runtimeProof.independentQa,
      verifier: { ...runtimeProof.independentQa.verifier, agentId: taskRecord.author.agentId } } },
    { ...runtimeProof, independentQa: { ...runtimeProof.independentQa,
      verifier: { ...runtimeProof.independentQa.verifier, sessionId: taskRecord.author.sessionId } } },
    { ...runtimeProof, independentQa: { ...runtimeProof.independentQa, runId: runtimeProof.runId } },
    { ...runtimeProof, independentQa: { ...runtimeProof.independentQa, runId: taskRecord.author.runId } },
    { ...runtimeProof, independentQa: { ...runtimeProof.independentQa,
      acceptedPins: { ...runtimeProof.independentQa.acceptedPins, approval: pin("core:execution-approval:old", "approval-old", "6".repeat(64)) } } },
    { ...runtimeProof, independentQa: { ...runtimeProof.independentQa,
      receipt: runtimeProof.execution.artifactPin }, report: runtimeProof.execution.artifactPin },
    { provenance: runtimeProof.provenance, scope, runId: "run-1", taskRecordSha256: taskDigest,
      status: "passed", report: qaReceipt } as unknown as GateRuntimeProof,
  ];
  for (const proof of invalid) {
    const producer = createWorkstreamVerificationProducer({ ...readers,
      runtimeProof: async () => ({ status: "available" as const, value: proof }) });
    assert.equal((await producer.verify(request)).status, "UNKNOWN");
  }
});

test("Baseline body reader requires exact current BaselineRef and preserves partial/unknown authority", async () => {
  const producer = createWorkstreamVerificationProducer(readers);
  assert.equal((await producer.verify({ ...request, baselineRef: { ...request.baselineRef, bodySha256: "f".repeat(64) } })).status, "UNKNOWN");
  const stale = createWorkstreamVerificationProducer({
    ...readers, baselineBodySource: { read: async () => ({ status: "available" as const, reason: null,
      document: baselineDocument as unknown as BaselineBodyRead["document"], source: "stale" as const,
      currentBaselineRevisionId: "base-2", bodyAvailable: true,
      historicalApproval: { status: "unknown" as const, reason: "Historical approval is not established." } }) },
  });
  assert.equal((await stale.verify(request)).status, "UNKNOWN");
  const bodyBytesMismatch = createWorkstreamVerificationProducer({
    ...readers, baselineBodySource: { read: async () => ({ status: "available" as const, reason: null,
      document: { ...baselineDocument, body: "tampered bytes" } as unknown as BaselineBodyRead["document"],
      source: "current" as const, currentBaselineRevisionId: "base-1", bodyAvailable: true,
      historicalApproval: { status: "unknown" as const, reason: "Historical approval is not established." } }) },
  });
  assert.equal((await bodyBytesMismatch.verify(request)).status, "UNKNOWN");
  const incorrectlyPromoted = createWorkstreamVerificationProducer({
    ...readers, baselineBodySource: { read: async () => ({ status: "available" as const, reason: null,
      document: { ...baselineDocument, inventory: { status: "complete", reason: "incorrect" } } as unknown as BaselineBodyRead["document"],
      source: "current" as const, currentBaselineRevisionId: "base-1", bodyAvailable: true,
      historicalApproval: { status: "approved" as const, reason: "incorrect" } as unknown as BaselineBodyRead["historicalApproval"] }) },
  });
  assert.equal((await incorrectlyPromoted.verify(request)).status, "UNKNOWN");
});

test("complete scoped reader evidence produces the exact current-consumer snapshot shape", async () => {
  const result = await createWorkstreamVerificationProducer(readers).verify(request);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.snapshot?.verificationStatus, "VERIFIED");
  assert.equal(result.snapshot?.eventId, request.eventId);
  assert.deepEqual(result.snapshot?.gateDecisions.map(gate => gate.gateId), ["G4", "G6"]);
  assert.deepEqual(result.snapshot?.gateDecisions[1]?.evidenceRefs, [runtimeProof.execution.artifactPin, runtimeProof.independentQa.receipt]);
  assert.deepEqual(result.snapshot?.qaEvidence, [{ result: "passed", report: runtimeProof.independentQa.receipt }]);
  assert.ok(result.snapshot?.sourcePins.some(item => item.sourceId === baselineDocument.documentId
    && item.revisionId === baselineDocument.documentRevisionId && item.sha256 === baselineBodySha256));
});
