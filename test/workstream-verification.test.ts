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
