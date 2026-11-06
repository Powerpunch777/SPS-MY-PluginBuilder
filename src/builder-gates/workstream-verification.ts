import { createHash } from "node:crypto";
import { parseTaskPacketRecord, taskPacketRecordDigest, type TaskPacketRecord } from "../domain/task-packets.ts";
import { parseWorkstreamBoard, type WorkstreamRecord } from "../domain/workstreams.ts";
import { workstreamInstructionDigest } from "../cto-delivery-store.ts";
import type { SpecCoverageResult } from "../spec-coverage/evaluator.ts";
import type { BaselineBodyRead } from "../project-documents/baseline-body-source.ts";
import type { EvidencePin } from "./workstream-verification-consumer.ts";

export type GateProofScope = Readonly<{ workspaceId: string; projectId: string; workstreamId: string; taskId: string }>;
// These identifiers serialize Builder adapter payloads; they are not Core API
// names or proof of authority. Authority belongs to the trusted server-bound
// reader implementation injected by the Host integration.
export type GateSourceInventory = Readonly<{
  provenance: Readonly<{ adapter: "builder.workstream-source-inventory.v1"; operation: "readCurrent" }>;
  scope: GateProofScope;
  complete: true;
  pins: readonly EvidencePin[];
  heads: readonly Readonly<{ sourceId: string; revisionId: string; sequence: number; digest: string }>[];
}>;
export type GateRuntimeProof = Readonly<{
  provenance: Readonly<{ adapter: "builder.workstream-runtime-proof.v1"; operation: "readCompletedRun" }>;
  scope: GateProofScope;
  runId: string;
  taskRecordSha256: string;
  status: "passed";
  commitSha: string;
  execution: Readonly<{
    planId: string;
    taskRevision: number;
    workstreamRevision: number;
    commitPin: EvidencePin;
    planPin: EvidencePin;
    environmentPin: EvidencePin;
    artifactPin: EvidencePin;
  }>;
  independentQa: Readonly<{
    status: "passed";
    verifier: Readonly<{ agentId: string; sessionId: string }>;
    runId: string;
    receipt: EvidencePin;
    acceptedPins: Readonly<{
      task: EvidencePin;
      workstream: EvidencePin;
      approval: EvidencePin;
      commit: EvidencePin;
      plan: EvidencePin;
      environment: EvidencePin;
      artifact: EvidencePin;
    }>;
  }>;
  report: EvidencePin;
}>;
export type BaselineRef = Readonly<{ documentId: string; documentRevisionId: string; bodySha256: string }>;
export type BaselineBodyReader = Readonly<{ read(documentRevisionId: string): Promise<BaselineBodyRead> }>;
export type GateReader<T> = (scope: GateProofScope) => Promise<Readonly<{ status: "available"; value: T }> | Readonly<{ status: "unknown"; reason: string }>>;
export type WorkstreamVerificationResult = Readonly<{
  status: "UNKNOWN" | "VERIFIED";
  reasons: readonly string[];
  snapshot: null | Readonly<{
    eventId: string;
    workspaceId: string;
    projectId: string;
    workstreamId: string;
    verificationStatus: "VERIFIED";
    taskId: string;
    taskRevision: number;
    taskRecordSha256: string;
    sourcePins: readonly EvidencePin[];
    gateDecisions: readonly Readonly<{ gateId: "G4" | "G6"; verdict: "PASS"; evidenceRefs: readonly EvidencePin[] }>[];
    qaEvidence: readonly Readonly<{ result: "passed"; report: EvidencePin }>[];
  }>;
}>;

const samePin = (a: EvidencePin, b: EvidencePin) => a.sourceId === b.sourceId && a.revisionId === b.revisionId && a.sha256 === b.sha256;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const unknown = (...reasons: string[]): WorkstreamVerificationResult => Object.freeze({
  status: "UNKNOWN", reasons: Object.freeze([...new Set(reasons)]), snapshot: null,
});
const sameScope = (actual: GateProofScope, expected: GateProofScope) => actual.workspaceId === expected.workspaceId
  && actual.projectId === expected.projectId && actual.workstreamId === expected.workstreamId && actual.taskId === expected.taskId;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object"
  && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const validPin = (value: unknown): value is EvidencePin => plain(value) && Reflect.ownKeys(value).length === 3
  && typeof value.sourceId === "string" && value.sourceId.length > 0 && typeof value.revisionId === "string"
  && value.revisionId.length > 0 && hash(value.sha256);

function exactCoveredTargets(scope: unknown, targets: unknown): boolean {
  try {
    if (!plain(scope) || !Array.isArray(scope.requirementIds) || !Array.isArray(scope.acIds)
      || !Array.isArray(targets)) return false;
    const requirements = Array.from(scope.requirementIds);
    const acceptanceCriteria = Array.from(scope.acIds);
    if ([...requirements, ...acceptanceCriteria].some(id => typeof id !== "string" || !id.trim())
      || new Set(requirements).size !== requirements.length
      || new Set(acceptanceCriteria).size !== acceptanceCriteria.length) return false;
    const expected = new Set([
      ...requirements.map(id => `requirement\0${id}`),
      ...acceptanceCriteria.map(id => `ac\0${id}`),
    ]);
    if (expected.size === 0 || targets.length !== expected.size) return false;
    const observed = new Set<string>();
    for (const target of Array.from(targets)) {
      if (!plain(target) || typeof target.targetId !== "string" || !target.targetId.trim()
        || (target.targetKind !== "requirement" && target.targetKind !== "ac") || target.status !== "COVERED") return false;
      const key = `${target.targetKind}\0${target.targetId}`;
      if (!expected.has(key) || observed.has(key)) return false;
      observed.add(key);
    }
    return observed.size === expected.size;
  } catch { return false; }
}

function validInventory(value: GateSourceInventory, scope: GateProofScope): boolean {
  try {
    return plain(value) && plain(value.provenance) && value.provenance.adapter === "builder.workstream-source-inventory.v1"
      && value.provenance.operation === "readCurrent" && value.complete === true
      && plain(value.scope) && sameScope(value.scope as unknown as GateProofScope, scope)
      && Array.isArray(value.pins) && value.pins.length > 0 && value.pins.every(validPin)
      && new Set(value.pins.map(pin => pin.sourceId)).size === value.pins.length
      && Array.isArray(value.heads) && value.heads.length === value.pins.length
      && value.heads.every(head => plain(head) && typeof head.sourceId === "string" && typeof head.revisionId === "string"
        && typeof head.sequence === "number" && Number.isSafeInteger(head.sequence) && head.sequence > 0 && hash(head.digest)
        && value.pins.some(pin => pin.sourceId === head.sourceId && pin.revisionId === head.revisionId && pin.sha256 === head.digest))
      && new Set(value.heads.map(head => head.sourceId)).size === value.heads.length;
  } catch { return false; }
}

function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Reflect.ownKeys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

function uniquePin(pins: readonly EvidencePin[], sourceId: string): EvidencePin | null {
  const matches = pins.filter(pin => pin.sourceId === sourceId);
  return matches.length === 1 ? matches[0]! : null;
}

function sameAcceptedPin(actual: unknown, expected: EvidencePin | null): boolean {
  return expected !== null && validPin(actual) && samePin(actual, expected);
}

function validRuntimeProof(value: GateRuntimeProof, scope: GateProofScope, task: TaskPacketRecord, taskDigest: string,
  workstream: WorkstreamRecord, inventory: GateSourceInventory): boolean {
  try {
    if (!exactFields(value, ["provenance", "scope", "runId", "taskRecordSha256", "status", "commitSha", "execution", "independentQa", "report"])) return false;
    if (!exactFields(value.provenance, ["adapter", "operation"])) return false;
    if (value.provenance.adapter !== "builder.workstream-runtime-proof.v1" || value.provenance.operation !== "readCompletedRun"
      || !plain(value.scope) || !sameScope(value.scope as unknown as GateProofScope, scope)
      || typeof value.runId !== "string" || !value.runId.trim() || value.status !== "passed"
      || value.taskRecordSha256 !== taskDigest || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.commitSha)
      || !exactFields(value.execution, ["planId", "taskRevision", "workstreamRevision", "commitPin", "planPin", "environmentPin", "artifactPin"])
      || !exactFields(value.independentQa, ["status", "verifier", "runId", "receipt", "acceptedPins"])
      || !exactFields(value.independentQa.verifier, ["agentId", "sessionId"])
      || !exactFields(value.independentQa.acceptedPins, ["task", "workstream", "approval", "commit", "plan", "environment", "artifact"])) return false;

    const execution = value.execution, qa = value.independentQa, accepted = qa.acceptedPins;
    const taskPin = uniquePin(inventory.pins, `builder-v1:task-packet:${scope.taskId}`);
    const workstreamPin = uniquePin(inventory.pins, `builder-v1:workstream:${scope.workstreamId}`);
    const commitPin = uniquePin(inventory.pins, "builder-v1:commit");
    const planPin = uniquePin(inventory.pins, `core:execution-plan:${execution.planId}`);
    const approvalPin = uniquePin(inventory.pins, `core:execution-approval:${execution.planId}`);
    const environmentPin = uniquePin(inventory.pins, "core:execution-environment");
    const artifactPin = uniquePin(inventory.pins, `core:runtime-artifact:${value.runId}`);
    const proofPins = [execution.commitPin, execution.planPin, execution.environmentPin, execution.artifactPin, qa.receipt];
    if (proofPins.some(pin => !validPin(pin)) || new Set(proofPins.map(pin => pin.sourceId)).size !== proofPins.length
      || !proofPins.every(proofPin => inventory.pins.some(pin => samePin(pin, proofPin)))) return false;
    if (!commitPin || commitPin.revisionId !== value.commitSha || !samePin(execution.commitPin, commitPin)
      || !planPin || !samePin(execution.planPin, planPin)
      || !environmentPin || !samePin(execution.environmentPin, environmentPin)
      || !artifactPin || !samePin(execution.artifactPin, artifactPin)
      || !taskPin || taskPin.sha256 !== taskDigest || !workstreamPin || workstreamPin.sha256 !== digest(workstream)
      || !approvalPin || execution.taskRevision !== task.packet.revision || execution.workstreamRevision !== workstream.spec.revision
      || typeof execution.planId !== "string" || !execution.planId.trim() || value.runId === task.author.runId
      || qa.status !== "passed" || typeof qa.runId !== "string" || !qa.runId.trim() || qa.runId === value.runId
      || qa.runId === task.author.runId || !plain(qa.verifier)
      || typeof qa.verifier.agentId !== "string" || !qa.verifier.agentId.trim() || qa.verifier.agentId === task.author.agentId
      || typeof qa.verifier.sessionId !== "string" || !qa.verifier.sessionId.trim() || qa.verifier.sessionId === task.author.sessionId
      || !validPin(qa.receipt) || qa.receipt.sourceId !== `core:qa-receipt:${qa.runId}`
      || !validPin(value.report) || !samePin(value.report, qa.receipt)) return false;
    return sameAcceptedPin(accepted.task, taskPin) && sameAcceptedPin(accepted.workstream, workstreamPin)
      && sameAcceptedPin(accepted.approval, approvalPin) && sameAcceptedPin(accepted.commit, commitPin)
      && sameAcceptedPin(accepted.plan, planPin) && sameAcceptedPin(accepted.environment, environmentPin)
      && sameAcceptedPin(accepted.artifact, artifactPin);
  } catch { return false; }
}

/**
 * Gate producer over canonical Workstream/TaskPacket/D3 inputs. The public SDK
 * has no Builder-specific inventory or runtime-proof operation. Absent readers
 * deliberately produce UNKNOWN. Adapter serialization is only a data shape;
 * it must be supplied by a trusted server-bound reader and does not establish
 * authority by itself.
 */
export function createWorkstreamVerificationProducer(readers: Readonly<{
  sourceInventory?: GateReader<GateSourceInventory>;
  runtimeProof?: GateReader<GateRuntimeProof>;
  baselineBodySource?: BaselineBodyReader;
}>) {
  return Object.freeze({
    async verify(input: Readonly<{
      eventId: string;
      scope: GateProofScope;
      ctoId: string;
      baselineRef: BaselineRef;
      workstream: WorkstreamRecord;
      taskRecord: unknown;
      coverage: SpecCoverageResult;
    }>): Promise<WorkstreamVerificationResult> {
      try {
      if (!readers.sourceInventory || !readers.runtimeProof || !readers.baselineBodySource) {
        return unknown(...[!readers.sourceInventory && "authenticated-current-source-inventory-reader-unregistered",
          !readers.runtimeProof && "core-runtime-proof-reader-unregistered",
          !readers.baselineBodySource && "baseline-body-source-reader-unregistered"].filter((value): value is string => Boolean(value)));
      }
      let task: TaskPacketRecord;
      try {
        task = parseTaskPacketRecord(input.taskRecord, input.scope.projectId, input.ctoId, input.scope.workstreamId);
        parseWorkstreamBoard({ projectId: input.scope.projectId, revisionId: "verification-scope",
          workstreams: [input.workstream] }, input.scope.projectId);
      } catch { return unknown("current-task-packet-invalid"); }
      const taskDigest = taskPacketRecordDigest(task, input.scope.projectId, input.ctoId, input.scope.workstreamId);
      if (typeof input.eventId !== "string" || !input.eventId.trim() || task.packet.taskId !== input.scope.taskId || task.packet.kind !== "development"
        || input.workstream.spec.projectId !== input.scope.projectId || input.workstream.spec.id !== input.scope.workstreamId
        || input.workstream.spec.assignedCtoId !== input.ctoId || task.source.specRevision !== input.workstream.spec.revision
        || task.source.workstreamId !== input.workstream.spec.id
        || task.source.instructionSha256 !== workstreamInstructionDigest(input.workstream)
        || task.author.agentId !== input.workstream.ctoAgentId || task.author.sessionId !== input.workstream.ctoSessionId
        || !task.packet.testPlan || !task.packet.scopeNodeIds.length
        || task.packet.scopeNodeIds.some(id => !input.workstream.spec.scopeNodeIds.includes(id))) {
        return unknown("g4-current-task-workstream-contract-mismatch");
      }
      const coverage = input.coverage;
      if (!coverage || coverage.inputIdentity?.workspaceId !== input.scope.workspaceId
        || coverage.inputIdentity?.projectId !== input.scope.projectId
        || coverage.inputIdentity?.specRevisionId !== input.workstream.spec.sourceSpecRevisionId
        || !Array.isArray(coverage.scope?.requirementIds)
        || task.packet.requirementIds.some(id => !coverage.scope.requirementIds.includes(id))
        || !exactCoveredTargets(coverage.scope, coverage.targets)
        || !Array.isArray(coverage.unknowns) || coverage.unknowns.length > 0) {
        return unknown("d3-coverage-not-completely-verified");
      }
      let baselineRead: BaselineBodyRead;
      try { baselineRead = await readers.baselineBodySource.read(input.baselineRef.documentRevisionId); }
      catch { return unknown("baseline-body-source-read-failed"); }
      const baselineDocument = baselineRead?.document;
      if (baselineRead.status !== "available" || baselineRead.source !== "current" || !baselineRead.bodyAvailable
        || !baselineDocument || baselineRead.currentBaselineRevisionId !== baselineDocument.sourceBaselineRevisionId
        || baselineDocument.workspaceId !== input.scope.workspaceId || baselineDocument.projectId !== input.scope.projectId
        || baselineDocument.documentId !== input.baselineRef.documentId
        || baselineDocument.documentRevisionId !== input.baselineRef.documentRevisionId
        || typeof baselineDocument.body !== "string" || sha256(baselineDocument.body) !== input.baselineRef.bodySha256
        || baselineDocument.bodySha256 !== input.baselineRef.bodySha256
        || baselineDocument.inventory.status !== "partial" || baselineDocument.historicalApproval.status !== "unknown"
        || baselineDocument.sourcePins[0]?.kind !== "baseline"
        || baselineDocument.sourcePins[0].revisionId !== baselineDocument.sourceBaselineRevisionId
        || baselineDocument.sourcePins[0].sha256 !== baselineDocument.sourceBaselineSha256
        || baselineDocument.sourceBaselineRevisionId !== input.workstream.sourceBaselineRevisionId
        || baselineDocument.sourceBaselineSha256 !== input.workstream.baselineDigest) {
        return unknown("baseline-document-ref-stale-unavailable-or-mismatched");
      }
      let inventoryRead: Awaited<ReturnType<typeof readers.sourceInventory>>;
      let runtimeRead: Awaited<ReturnType<typeof readers.runtimeProof>>;
      try { [inventoryRead, runtimeRead] = await Promise.all([readers.sourceInventory(input.scope), readers.runtimeProof(input.scope)]); }
      catch { return unknown("core-gate-evidence-read-failed"); }
      if (inventoryRead.status !== "available") return unknown(inventoryRead.reason || "authenticated-current-source-inventory-unavailable");
      if (runtimeRead.status !== "available") return unknown(runtimeRead.reason || "core-runtime-proof-unavailable");
      const inventory = inventoryRead.value, runtime = runtimeRead.value;
      if (!validInventory(inventory, input.scope)) return unknown("authenticated-current-source-inventory-invalid-or-incomplete");
      if (!validRuntimeProof(runtime, input.scope, task, taskDigest, input.workstream, inventory)) {
        return unknown("core-runtime-proof-invalid-or-out-of-scope");
      }
      if (!inventory.pins.some(pin => samePin(pin, runtime.report))) return unknown("runtime-report-not-in-current-source-inventory");
      const taskSource = inventory.pins.find(pin => pin.sourceId === `builder-v1:task-packet:${input.scope.taskId}`);
      if (!taskSource || taskSource.sha256 !== taskDigest) return unknown("task-packet-not-bound-to-current-source-inventory");
      const requiredKinds = ["baseline", "graph", "workstream", "task-packet"] as const;
      if (requiredKinds.some(kind => !inventory.pins.some(pin => pin.sourceId.startsWith(`builder-v1:${kind}:`)))) {
        return unknown("g4-required-source-inventory-kinds-missing");
      }
      const currentBaselinePin = inventory.pins.find(pin => pin.sourceId === `builder-v1:baseline:${baselineDocument.sourceBaselineRevisionId}`);
      if (!currentBaselinePin || currentBaselinePin.revisionId !== baselineDocument.sourceBaselineRevisionId
        || currentBaselinePin.sha256 !== baselineDocument.sourceBaselineSha256) {
        return unknown("baseline-document-source-not-bound-to-current-inventory");
      }
      const currentWorkstreamPin = inventory.pins.find(pin => pin.sourceId === `builder-v1:workstream:${input.scope.workstreamId}`);
      if (!currentWorkstreamPin || currentWorkstreamPin.sha256 !== digest(input.workstream)) {
        return unknown("workstream-record-not-bound-to-current-source-inventory");
      }
      const g4 = inventory.pins.filter(pin => requiredKinds.some(kind => pin.sourceId.startsWith(`builder-v1:${kind}:`)));
      const baselineBodyPin: EvidencePin = Object.freeze({ sourceId: baselineDocument.documentId,
        revisionId: baselineDocument.documentRevisionId, sha256: baselineDocument.bodySha256 });
      const g6 = [runtime.execution.artifactPin, runtime.independentQa.receipt];
      return Object.freeze({ status: "VERIFIED", reasons: Object.freeze([]), snapshot: Object.freeze({
        eventId: input.eventId,
        workspaceId: input.scope.workspaceId, projectId: input.scope.projectId, workstreamId: input.scope.workstreamId,
        verificationStatus: "VERIFIED" as const,
        taskId: input.scope.taskId, taskRevision: task.packet.revision, taskRecordSha256: taskDigest,
        sourcePins: Object.freeze([...inventory.pins, baselineBodyPin]),
        gateDecisions: Object.freeze([
          Object.freeze({ gateId: "G4" as const, verdict: "PASS" as const, evidenceRefs: Object.freeze([...g4, baselineBodyPin]) }),
          Object.freeze({ gateId: "G6" as const, verdict: "PASS" as const, evidenceRefs: Object.freeze(g6) }),
        ]), qaEvidence: Object.freeze([Object.freeze({ result: "passed" as const, report: runtime.independentQa.receipt })]),
      }) });
      } catch { return unknown("workstream-verification-input-or-reader-malformed"); }
    },
  });
}
