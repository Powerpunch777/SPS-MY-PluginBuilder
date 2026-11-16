import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import type { WorkstreamRecord } from "../src/domain/workstreams.ts";
import type { SpecCoverageResult } from "../src/spec-coverage/evaluator.ts";
import type { BaselineBodyRead } from "../src/project-documents/baseline-body-source.ts";
import { createTaskPacketStore } from "../src/task-packet-tools.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { createWorkstreamVerificationProducer, type BaselineBodyReader, type GateProofScope,
  type GateRuntimeProof, type GateSourceInventory } from "../src/builder-gates/workstream-verification.ts";
import { consumeVerifiedWorkstream, type ManagerDispatchPort, type VerifiedSnapshotReader } from "../src/builder-gates/workstream-verification-consumer.ts";
import { createRuntimeEvidenceAdapter } from "../src/builder-gates/runtime-evidence.ts";
import { createWorkstreamStore } from "../src/workstream-tools.ts";
import { C, CTO, P, R, W, ctx, fixture } from "./fixtures/cto-platform.ts";

const FAILED_TASK_RUN = "88888888-8888-4888-8888-888888888888";
const scope: GateProofScope = { workspaceId: W, projectId: P, workstreamId: "ws-1", taskId: "task-1" };
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const pin = (sourceId: string, revisionId: string, digest: string) => ({ sourceId, revisionId, sha256: digest });

// TEST_FIXTURE_ONLY: fake SDK state/run, evidence pins, and Manager receipt; no Host, Core, user data, or live auth.
async function preparedFailedRun() {
  const f = await fixture();
  const instruction = f.instruction;
  const taskRecord = {
    packet: {
      projectId: P, ctoId: CTO, workstreamId: scope.workstreamId, taskId: scope.taskId, revision: 1,
      kind: "development", title: "Fixture task", goal: "Check that failed admission cannot prove G4/G6.",
      scopeNodeIds: ["feature"], requirementIds: ["REQ-1"], dependencies: [], included: ["Feature"],
      excluded: [], constraints: [], acceptance: ["Evidence stays fail-closed."], evidenceRequired: ["Runtime report"],
      reuse: [], testPlan: { environment: "Node", steps: ["Run focused tests"], expectedResults: ["Pass"], passCriteria: ["All assertions pass"] },
    },
    source: { requestId: R, workstreamId: scope.workstreamId, specRevision: 1,
      instructionSha256: workstreamInstructionDigest(instruction) },
    author: { agentId: "22222222-2222-4222-8222-222222222222", sessionId: C, runId: FAILED_TASK_RUN },
    createdAtISO: "2026-11-06T00:00:00.000Z", dependencyPins: [],
  };
  const taskStore = createTaskPacketStore(W, P, CTO, scope.workstreamId, f.state);
  await taskStore.publish({ expectedBaseRevisionId: null, revision: { projectId: P, ctoId: CTO,
    workstreamId: scope.workstreamId, revisionId: "task-board-1", packets: [taskRecord] } });
  f.runs.set(FAILED_TASK_RUN, { runId: FAILED_TASK_RUN, status: "failed", cancellationRequested: false,
    termination: "not_applicable", error: "The Host plugin session has no active scoped execution delegation.",
    errorCode: "execution_target_unavailable", output: { state: "available", text: "No model execution occurred." } });
  const workstream = (await createWorkstreamStore(W, P, f.state).current())!.revision.workstreams[0]!;
  const adapter = createRuntimeEvidenceAdapter({ ctoId: CTO, runContext: ctx(), platform: f.platform });

  const taskDigest = taskPacketRecordDigest(taskRecord, P, CTO, scope.workstreamId);
  const workstreamDigest = sha256(JSON.stringify(workstream));
  const baselineDigest = instruction.baselineDigest;
  const commitSha = "a".repeat(40);
  const taskPin = pin(`builder-v1:task-packet:${scope.taskId}`, "task-r1", taskDigest);
  const workstreamPin = pin(`builder-v1:workstream:${scope.workstreamId}`, "ws-r1", workstreamDigest);
  const approvalPin = pin("core:execution-approval:plan-1", "approval-r1", "6".repeat(64));
  const commitPin = pin("builder-v1:commit", commitSha, "7".repeat(64));
  const planPin = pin("core:execution-plan:plan-1", "plan-r1", "8".repeat(64));
  const environmentPin = pin("core:execution-environment", "env-r1", "9".repeat(64));
  const artifactPin = pin("core:runtime-artifact:run-1", "artifact-r1", "a".repeat(64));
  const qaReceipt = pin("core:qa-receipt:qa-run-1", "qa-r1", "b".repeat(64));
  const pins = [pin("builder-v1:baseline:baseline-1", "baseline-1", baselineDigest),
    pin("builder-v1:graph:graph-1", "graph-1", "2".repeat(64)), workstreamPin, taskPin, approvalPin,
    commitPin, planPin, environmentPin, artifactPin, qaReceipt];
  const inventory: GateSourceInventory = {
    provenance: { adapter: "builder.workstream-source-inventory.v1", operation: "readCurrent" },
    scope, complete: true, pins,
    heads: pins.map((item, index) => ({ sourceId: item.sourceId, revisionId: item.revisionId,
      sequence: index + 1, digest: item.sha256 })),
  };

  const body = "# Fixture baseline";
  const bodySha256 = sha256(body);
  const baselineDocument = {
    schemaVersion: 1, workspaceId: W, projectId: P, documentId: "baseline-body:doc-1",
    documentRevisionId: "document-r1", createdAt: "2026-11-06T00:00:00.000Z",
    sourceBaselineRevisionId: "baseline-1", sourceBaselineSequence: 1, sourceBaselineSha256: baselineDigest,
    body, bodySha256,
    sourcePins: [{ kind: "baseline", id: `${W}/${P}`, revisionId: "baseline-1", sha256: baselineDigest }],
    inventory: { status: "partial", reason: "Fixture only." },
    historicalApproval: { status: "unknown", reason: "Fixture only." },
  };
  const baselineBodySource: BaselineBodyReader = { async read(revisionId) {
    if (revisionId !== baselineDocument.documentRevisionId) return { status: "unavailable", reason: "not-found",
      document: null, source: "unknown", currentBaselineRevisionId: "baseline-1", bodyAvailable: false, historicalApproval: null };
    return { status: "available", reason: null, document: baselineDocument as unknown as BaselineBodyRead["document"],
      source: "current", currentBaselineRevisionId: "baseline-1", bodyAvailable: true,
      historicalApproval: { status: "unknown", reason: "Fixture only." } };
  } };
  const coverage = {
    inputIdentity: { workspaceId: W, projectId: P, specRevisionId: instruction.spec.sourceSpecRevisionId },
    scope: { requirementIds: ["REQ-1"], acIds: ["AC-1"] },
    targets: [{ targetId: "REQ-1", targetKind: "requirement", status: "COVERED" },
      { targetId: "AC-1", targetKind: "ac", status: "COVERED" }], unknowns: [],
  } as unknown as SpecCoverageResult;
  const request = { eventId: "event-failed-core-run", scope, ctoId: CTO,
    baselineRef: { documentId: baselineDocument.documentId, documentRevisionId: baselineDocument.documentRevisionId, bodySha256 },
    workstream: workstream as WorkstreamRecord, taskRecord, coverage };
  const producer = createWorkstreamVerificationProducer({
    sourceInventory: async () => ({ status: "available" as const, value: inventory }),
    runtimeProof: adapter.runtimeProof,
    baselineBodySource,
  });
  return { f, adapter, producer, request };
}

test("failed Core pre-model admission remains observation only and cannot produce VERIFIED or dispatch", async () => {
  const { adapter, producer, request } = await preparedFailedRun();
  const observation = await adapter.observe(scope);
  assert.equal(observation.status, "observed");
  if (observation.status !== "observed") return;
  assert.equal(observation.taskAuthorRun.status, "failed");
  assert.equal(observation.taskAuthorRun.outputState, "available");
  assert.equal(observation.artifactEvidence.status, "unavailable");
  assert.equal(observation.independentQa.status, "not-established");
  assert.equal(observation.gateProof.status, "unknown");
  assert.equal((await adapter.runtimeProof(scope)).status, "unknown");

  const verified = await producer.verify(request);
  assert.equal(verified.status, "UNKNOWN");
  assert.equal(verified.snapshot, null);
  assert.ok(verified.reasons.some(reason => reason.includes("authoritative runtime artifact and independent verifier")));

  const values = new Map<string, JsonValue>();
  const state = {
    async get(key: SpsStateKey) { return values.get(JSON.stringify(key)) ?? null; },
    async compareAndSet() { throw new Error("UNKNOWN verification must not reserve a Manager dispatch."); },
  };
  let dispatchCount = 0;
  const manager: ManagerDispatchPort = {
    async dispatch() { dispatchCount += 1; },
    async readReceipt() { return { status: "uncertain", reason: "not-expected" }; },
  };
  const readCurrent: VerifiedSnapshotReader = async () => ({ status: "unknown", reason: verified.reasons.join(",") });
  const consumed = await consumeVerifiedWorkstream({ workspaceId: W, projectId: P, workstreamId: "ws-1", eventId: request.eventId },
    state, readCurrent, manager);
  assert.equal(consumed.status, "unknown");
  assert.equal(dispatchCount, 0);
  assert.equal(values.size, 0);
});

test("an accepted Manager receipt confirms request acceptance only, never integration completion", async () => {
  const sourcePins = [pin("task", "task-r1", "a".repeat(64)), pin("artifact", "artifact-r1", "b".repeat(64)),
    pin("qa", "qa-r1", "c".repeat(64))];
  const snapshot = {
    eventId: "event-accepted", workspaceId: W, projectId: P, workstreamId: "ws-1", verificationStatus: "VERIFIED" as const,
    sourcePins,
    gateDecisions: [
      { gateId: "G4" as const, verdict: "PASS" as const, evidenceRefs: [sourcePins[0]!] },
      { gateId: "G6" as const, verdict: "PASS" as const, evidenceRefs: [sourcePins[1]!, sourcePins[2]!] },
    ],
    qaEvidence: [{ result: "passed" as const, report: sourcePins[2]! }],
  };
  const values = new Map<string, JsonValue>();
  const state = {
    async get(key: SpsStateKey) { return values.get(JSON.stringify(key)) ?? null; },
    async compareAndSet(key: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) {
      const id = JSON.stringify(key), old = values.get(id);
      const matches = expected.exists ? old !== undefined && JSON.stringify(old) === JSON.stringify(expected.value) : old === undefined;
      if (matches) values.set(id, structuredClone(value));
      return { swapped: matches };
    },
  };
  const calls: unknown[] = [];
  const manager: ManagerDispatchPort = {
    async dispatch(request) { calls.push(request); },
    async readReceipt(requestId) { return { status: "accepted", requestId, receiptId: "receipt-1", runId: "manager-run-1" }; },
  };
  const readCurrent: VerifiedSnapshotReader = async () => ({ status: "current", snapshot });
  const result = await consumeVerifiedWorkstream({ workspaceId: W, projectId: P, workstreamId: "ws-1", eventId: snapshot.eventId },
    state, readCurrent, manager);

  assert.equal(result.status, "accepted");
  assert.equal(result.reason, "manager-acceptance-receipt-confirmed-not-completion");
  assert.deepEqual(result.receipt, { receiptId: "receipt-1", runId: "manager-run-1" });
  assert.equal("integrated" in result, false);
  assert.equal("completed" in result, false);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify([...values.values()]).includes("integrated"), false);
});
