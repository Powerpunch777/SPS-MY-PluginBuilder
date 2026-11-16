import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { JsonValue, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { taskPacketRecordDigest } from "../src/domain/task-packets.ts";
import type { TaskPacketBoard, TaskPacketRecord } from "../src/domain/task-packets.ts";
import type { WorkstreamRecord } from "../src/domain/workstreams.ts";
import type { SpecCoverageResult } from "../src/spec-coverage/evaluator.ts";
import type { BaselineBodyRead } from "../src/project-documents/baseline-body-source.ts";
import { workstreamInstructionDigest } from "../src/cto-delivery-store.ts";
import { createWorkstreamVerificationPublication } from "../src/builder-gates/workstream-verification-publication.ts";
import type { GateProofScope, GateRuntimeProof, GateSourceInventory } from "../src/builder-gates/workstream-verification.ts";
import type { RevisionState, RevisionJobWake } from "../src/solution-revision-store.ts";

const workstreamScope = { workspaceId: "11111111-1111-4111-8111-111111111111", projectId: "project-1", workstreamId: "ws-1" };
const ctoId = "cto-1";
const ctoAgentId = "88888888-8888-4888-8888-888888888888";
const ctoSessionId = "99999999-9999-4999-8999-999999999999";
const taskIds = ["task-1", "task-2"] as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const pin = (sourceId: string, revisionId: string, sha256: string) => ({ sourceId, revisionId, sha256 });

function taskRecord(taskId: string, nodeId: string): TaskPacketRecord {
  return { packet: { projectId: workstreamScope.projectId, ctoId, workstreamId: workstreamScope.workstreamId,
    taskId, revision: 1, kind: "development", title: `Implement ${taskId}`, goal: "Implement scoped feature",
    scopeNodeIds: [nodeId], requirementIds: ["req-1"], dependencies: [], included: [nodeId], excluded: [], constraints: [],
    acceptance: ["passes"], evidenceRequired: ["runtime report"], reuse: [],
    testPlan: { environment: "Node", steps: ["run"], expectedResults: ["pass"], passCriteria: ["all tests pass"] } },
    source: { requestId: "22222222-2222-4222-8222-222222222222", workstreamId: workstreamScope.workstreamId,
      specRevision: 1, instructionSha256: workstreamInstructionDigest(workstream) },
    author: { agentId: ctoAgentId, sessionId: ctoSessionId,
      runId: "55555555-5555-4555-8555-555555555555" },
    createdAtISO: "2026-11-06T00:00:00.000Z", dependencyPins: [] } as TaskPacketRecord;
}

const workstream = {
  spec: { projectId: workstreamScope.projectId, id: workstreamScope.workstreamId, revision: 1,
    sourceSpecRevisionId: "spec-r1", assignedCtoId: ctoId, title: "Feature", goal: "Deliver the feature",
    scopeNodeIds: ["node-1", "node-2"], included: ["Feature"], excluded: [], dependencies: [], interfaceContracts: [],
    technologyDecisionsRef: "tech-r1", reuseCandidates: [], acceptance: ["Acceptance passes"],
    evidenceRequired: ["Evidence is recorded"], openQuestions: [] },
  sourceBaselineRevisionId: "base-1", baselineDigest: "1".repeat(64), technologyDigest: "2".repeat(64),
  ctoAgentId, ctoSessionId,
  author: { agentId: "33333333-3333-4333-8333-333333333333", sessionId: "44444444-4444-4444-8444-444444444444",
    runId: "55555555-5555-4555-8555-555555555555", selectionRevision: 1 },
  createdAt: "2026-11-06T00:00:00.000Z",
  change: { previousRevision: null, reason: "Initial assignment", diff: "Create the scoped Workstream",
    impactNodeIds: ["node-1", "node-2"], impactInterfaceContracts: [], impactTaskIds: [], effectiveFrom: "After delivery" },
  receipt: null,
} satisfies WorkstreamRecord;
const records = [taskRecord(taskIds[0], "node-1"), taskRecord(taskIds[1], "node-2")];
const coverage = { inputIdentity: { workspaceId: workstreamScope.workspaceId, projectId: workstreamScope.projectId,
  specRevisionId: "spec-r1" }, scope: { requirementIds: ["req-1"], acIds: ["ac-1"] }, targets: [
    { targetId: "req-1", targetKind: "requirement", status: "COVERED" },
    { targetId: "ac-1", targetKind: "ac", status: "COVERED" },
  ], unknowns: [], } as unknown as SpecCoverageResult;
const baselineBody = "# Baseline", baselineBodySha = sha(baselineBody);
const baselineDocument = { schemaVersion: 1, workspaceId: workstreamScope.workspaceId, projectId: workstreamScope.projectId,
  documentId: "baseline-body:doc-1", documentRevisionId: "document-r1", createdAt: "2026-11-06T00:00:00.000Z",
  sourceBaselineRevisionId: "base-1", sourceBaselineSequence: 1, sourceBaselineSha256: "1".repeat(64),
  body: baselineBody, bodySha256: baselineBodySha, sourcePins: [
    { kind: "baseline", id: "baseline", revisionId: "base-1", sha256: "1".repeat(64) },
    { kind: "specification", id: "spec", revisionId: "spec-r1", sha256: "2".repeat(64) },
    { kind: "graph", id: "graph", revisionId: "graph-r1", sha256: "3".repeat(64) },
    { kind: "draft", id: "draft", revisionId: "draft-r1", sha256: "4".repeat(64) },
    { kind: "user-source", id: "decision", revisionId: "decision-r1", sha256: "5".repeat(64) },
  ], inventory: { status: "partial", reason: "Fixture" }, historicalApproval: { status: "unknown", reason: "Fixture" } };
const baselineBodySource = { async read(documentRevisionId: string) {
  return documentRevisionId === baselineDocument.documentRevisionId
    ? { status: "available" as const, reason: null, document: baselineDocument as unknown as BaselineBodyRead["document"],
      source: "current" as const, currentBaselineRevisionId: "base-1", bodyAvailable: true,
      historicalApproval: { status: "unknown" as const, reason: "Fixture" } }
    : { status: "unavailable" as const, reason: "missing", document: null, source: "unknown" as const,
      currentBaselineRevisionId: null, bodyAvailable: false, historicalApproval: null };
} };

function taskEvidence(record: TaskPacketRecord) {
  const taskId = record.packet.taskId, taskDigest = taskPacketRecordDigest(record, workstreamScope.projectId, ctoId, workstreamScope.workstreamId);
  const runId = `run-${taskId}`, qaRunId = `qa-${taskId}`, planId = `plan-${taskId}`;
  const taskPin = pin(`builder-v1:task-packet:${taskId}`, `task-r${record.packet.revision}`, taskDigest);
  const workstreamPin = pin(`builder-v1:workstream:${workstreamScope.workstreamId}`, "ws-r1", digest(workstream));
  const approvalPin = pin(`core:execution-approval:${planId}`, `approval-${taskId}`, "6".repeat(64));
  const commitPin = pin("builder-v1:commit", "a".repeat(40), "7".repeat(64));
  const planPin = pin(`core:execution-plan:${planId}`, `plan-${taskId}`, "8".repeat(64));
  const environmentPin = pin("core:execution-environment", "env-r1", "9".repeat(64));
  const artifactPin = pin(`core:runtime-artifact:${runId}`, `artifact-${taskId}`, "a".repeat(64));
  const qaPin = pin(`core:qa-receipt:${qaRunId}`, `qa-${taskId}`, "b".repeat(64));
  const pins = [pin("builder-v1:baseline:base-1", "base-1", "1".repeat(64)),
    pin("builder-v1:graph:graph-1", "graph-r1", "2".repeat(64)), workstreamPin, taskPin, approvalPin, commitPin,
    planPin, environmentPin, artifactPin, qaPin];
  const scope: GateProofScope = { ...workstreamScope, taskId };
  const inventory: GateSourceInventory = { provenance: { adapter: "builder.workstream-source-inventory.v1", operation: "readCurrent" },
    scope, complete: true, pins, heads: pins.map((item, index) => ({ sourceId: item.sourceId,
      revisionId: item.revisionId, sequence: index + 1, digest: item.sha256 })) };
  const runtimeProof: GateRuntimeProof = { provenance: { adapter: "builder.workstream-runtime-proof.v1", operation: "readCompletedRun" },
    scope, runId, taskRecordSha256: taskDigest, status: "passed", commitSha: "a".repeat(40),
    execution: { planId, taskRevision: record.packet.revision, workstreamRevision: 1, commitPin, planPin, environmentPin, artifactPin },
    independentQa: { status: "passed", verifier: { agentId: `66666666-6666-4666-8666-66666666666${taskId.endsWith("1") ? "6" : "7"}`,
      sessionId: `77777777-7777-4777-8777-77777777777${taskId.endsWith("1") ? "7" : "8"}` }, runId: qaRunId, receipt: qaPin,
      acceptedPins: { task: taskPin, workstream: workstreamPin, approval: approvalPin, commit: commitPin,
        plan: planPin, environment: environmentPin, artifact: artifactPin } }, report: qaPin };
  const input = { scope, ctoId, baselineRef: { documentId: baselineDocument.documentId,
    documentRevisionId: baselineDocument.documentRevisionId, bodySha256: baselineBodySha }, workstream,
    taskRecord: record, coverage };
  return { input, inventory, runtimeProof };
}

const evidence = records.map(taskEvidence);
const readers = {
  sourceInventory: async (scope: GateProofScope) => ({ status: "available" as const,
    value: evidence.find(item => item.input.scope.taskId === scope.taskId)!.inventory }),
  runtimeProof: async (scope: GateProofScope) => ({ status: "available" as const,
    value: evidence.find(item => item.input.scope.taskId === scope.taskId)!.runtimeProof }),
  baselineBodySource,
};
const taskBoard = { projectId: workstreamScope.projectId, ctoId, workstreamId: workstreamScope.workstreamId,
  revisionId: "task-board-r1", packets: records } as unknown as TaskPacketBoard;

test("aggregate readCurrent rejects source drift after guard read using atomic no-op CAS", async () => {
  const sourceKey: SpsStateKey = { scopeKind: "company", scopeId: workstreamScope.workspaceId, stateKey: "fixture-source-head" };
  const key = (address: SpsStateKey) => JSON.stringify([address.scopeKind, address.scopeId, address.namespace ?? "default", address.stateKey]);
  const values = new Map<string, JsonValue>([[key(sourceKey), { revision: "r1" }]]);
  const wakes: RevisionJobWake[] = [];
  let mutateBeforeGuardedValidation = false, raced = false, readValidations = 0;
  const matchesGuards = (address: { scopeId: string; guards: readonly { stateKey: string; namespace?: string; expectedValue: JsonValue }[] }) =>
    address.guards.every(guard => JSON.stringify(values.get(key({ scopeKind: "company", scopeId: address.scopeId,
      stateKey: guard.stateKey, ...(guard.namespace === undefined ? {} : { namespace: guard.namespace }) }))) === JSON.stringify(guard.expectedValue));
  const swap = (address: SpsStateKey, expected: { exists: false } | { exists: true; value: JsonValue }, value: JsonValue) => {
    const current = values.get(key(address));
    const matches = expected.exists ? JSON.stringify(current) === JSON.stringify(expected.value) : current === undefined;
    if (matches) values.set(key(address), structuredClone(value));
    return matches;
  };
  const state: RevisionState = {
    async get(address) { return structuredClone(values.get(key(address)) ?? null); },
    async compareAndSet(address, expected, value) { return { swapped: swap(address, expected, value) }; },
    async guardedCompareAndSet(address, expected, value) {
      readValidations++;
      if (mutateBeforeGuardedValidation) {
        mutateBeforeGuardedValidation = false; raced = true; values.set(key(sourceKey), { revision: "r2" });
      }
      return matchesGuards(address) && swap(address, expected, value) ? { status: "committed" } : { status: "conflict" };
    },
    async guardedCompareAndSetWithJobWakeV1(address, expected, value, wake) {
      if (!matchesGuards(address) || !swap(address, expected, value)) return { status: "conflict" };
      wakes.push(structuredClone(wake)); return { status: "committed" };
    },
  };
  const authority = async () => ({ status: "available" as const, taskBoard, inputs: evidence.map(item => item.input), readers,
    bindGuards: async (verified: readonly { sourcePins: readonly { sourceId: string }[] }[]) => [{
      stateKey: sourceKey.stateKey, expectedValue: { revision: "r1" },
      sourceIds: [...new Set(verified.flatMap(item => item.sourcePins.map(pin => pin.sourceId)))],
    }] });
  const publication = createWorkstreamVerificationPublication(state, authority);
  const published = await publication.publish(workstreamScope);
  assert.equal(published.status, "published", "fixture must verify and publish every development packet on the Workstream");
  assert.equal(wakes.length, 1);

  mutateBeforeGuardedValidation = true;
  const read = await publication.readCurrent({ ...workstreamScope, eventId: published.eventId! });
  assert.equal(raced, true, "source mutates immediately before the atomic guard comparison");
  assert.notEqual(read.status, "current", "atomic observation must reject a source changed in the read/CAS gap");
  assert.ok(readValidations >= 1, "readCurrent must use the existing guarded CAS without a wake");
  assert.equal(wakes.length, 1, "read validation must not publish another wake");
});

test("publication rejects a task pinned to a different Workstream instruction digest", async () => {
  const staleRecord = { ...records[0]!, source: { ...records[0]!.source, instructionSha256: "f".repeat(64) } };
  const inputs = evidence.map(item => item.input.scope.taskId === staleRecord.packet.taskId
    ? { ...item.input, taskRecord: staleRecord } : item.input);
  let stateWrites = 0, jobWakes = 0;
  const state: RevisionState = {
    async get() { return null; },
    async compareAndSet() { stateWrites++; return { swapped: true }; },
    async guardedCompareAndSetWithJobWakeV1() { jobWakes++; return { status: "conflict" }; },
  };
  const authority = async () => ({ status: "available" as const, taskBoard, inputs, readers,
    bindGuards: async (verified: readonly { sourcePins: readonly { sourceId: string }[] }[]) => [{
      stateKey: "fixture-source-head", expectedValue: { revision: "r1" },
      sourceIds: [...new Set(verified.flatMap(item => item.sourcePins.map(pin => pin.sourceId)))],
    }] });
  const result = await createWorkstreamVerificationPublication(state, authority).publish(workstreamScope);
  assert.equal(result.status, "unknown", "a stale TaskPacket source must fail closed before aggregate publication");
  assert.equal(stateWrites, 0, "invalid source binding must not stage or publish a journal entry");
  assert.equal(jobWakes, 0, "invalid source binding must not enqueue a Manager job");
});
