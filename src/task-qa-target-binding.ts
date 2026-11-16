import { createHash } from "node:crypto";
import { parseTaskWorkerRegistry, type TaskWorkerRecord } from "./domain/task-workers.ts";
import { parseTaskPacketRecord, taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { deriveTaskWorkerFileBinding } from "./task-worker-runtime.ts";

const SHA1_OR_256 = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

export type AcceptedTaskSourceReceipt = Readonly<{
  schemaVersion: 1;
  acceptanceId: string;
  submissionId: string;
  workspaceId: string;
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  packetRevision: number;
  packetRecordSha256: string;
  dependencyPins: readonly Readonly<{ taskId: string; revision: number; recordSha256: string }>[];
  source: Readonly<{ sourceId: string; folderKey: string; branch: string; expectedHead: string }>;
  commitSha: string;
  treeSha: string;
  changedPaths: readonly string[];
  receivedBy: Readonly<{ agentId: string; sessionId: string; runId: string }>;
  receivedAt: string;
  meaning: "cto-received-exact-submitted-commit";
}>;

export type ProtectedTaskRunReceipt = Readonly<{
  schemaVersion: 1;
  kind: "protected-node-test-v1";
  id: string;
  status: "queued" | "claimed" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  termination: "not_applicable" | "pending" | "confirmed";
  pins: Readonly<{ sourceId: string; commitSha: string; treeSha: string; subjectKeySha256: string }>;
  qaVerdict: "not-established";
}>;

export type TaskQaTargetReadiness = Readonly<{
  status: "ready" | "blocked" | "unsupported";
  reason: string;
  target: Readonly<{ sourceId: string; folderKey: string; branch: string; commitSha: string; treeSha: string;
    implementationTaskId: string; implementationPacketRevision: number; implementationPacketRecordSha256: string;
    qaTaskId: string; qaPacketRevision: number; qaPacketRecordSha256: string; qaWorkerAgentId: string; qaWorkerSessionId: string }> | null;
  scheduleAllowed: boolean;
  qaPreparation: "ready" | "unknown";
  qaExecution: "not-started";
  qaVerdict: "not-established";
}>;

function exactRecord(value: unknown, required: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain record.`);
  const keys = Reflect.ownKeys(value), allowed = new Set(required);
  if (keys.length !== required.length || keys.some(key => typeof key !== "string" || !allowed.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields.`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must contain only own data properties.`);
    output[key] = descriptor.value;
  }
  return output;
}

function parseAcceptance(value: unknown): AcceptedTaskSourceReceipt {
  const row = exactRecord(value, ["schemaVersion", "acceptanceId", "submissionId", "workspaceId", "projectId", "ctoId", "workstreamId",
    "taskId", "packetRevision", "packetRecordSha256", "dependencyPins", "source", "commitSha", "treeSha", "changedPaths",
    "receivedBy", "receivedAt", "meaning"], "CTO source acceptance");
  const source = exactRecord(row.source, ["sourceId", "folderKey", "branch", "expectedHead"], "Accepted source pins");
  const receivedBy = exactRecord(row.receivedBy, ["agentId", "sessionId", "runId"], "CTO receiver");
  const pins = row.dependencyPins;
  const changedPaths = row.changedPaths;
  if (row.schemaVersion !== 1 || typeof row.acceptanceId !== "string" || !SHA256.test(row.acceptanceId)
    || typeof row.submissionId !== "string" || !SHA256.test(row.submissionId)
    || typeof row.workspaceId !== "string" || !uuid.test(row.workspaceId)
    || ![row.projectId, row.ctoId, row.workstreamId, row.taskId].every(item => typeof item === "string" && !!item.trim() && item.length <= 160)
    || !Number.isSafeInteger(row.packetRevision) || (row.packetRevision as number) < 1
    || typeof row.packetRecordSha256 !== "string" || !SHA256.test(row.packetRecordSha256)
    || typeof source.sourceId !== "string" || !uuid.test(source.sourceId)
    || typeof source.folderKey !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(source.folderKey)
    || typeof source.branch !== "string" || !source.branch || source.branch.length > 240
    || typeof source.expectedHead !== "string" || !SHA1_OR_256.test(source.expectedHead)
    || typeof row.commitSha !== "string" || !SHA1_OR_256.test(row.commitSha)
    || typeof row.treeSha !== "string" || !SHA1_OR_256.test(row.treeSha)
    || !Array.isArray(pins) || pins.length > 64 || Reflect.ownKeys(pins).length !== pins.length + 1
    || !Array.isArray(changedPaths) || changedPaths.length < 1 || changedPaths.length > 64
    || changedPaths.some(path => typeof path !== "string" || !path || path.length > 1_024)
    || ![receivedBy.agentId, receivedBy.sessionId, receivedBy.runId].every(item => typeof item === "string" && uuid.test(item))
    || typeof row.receivedAt !== "string" || !Number.isFinite(Date.parse(row.receivedAt))
    || row.meaning !== "cto-received-exact-submitted-commit") throw new TypeError("CTO source acceptance receipt is malformed.");
  return value as AcceptedTaskSourceReceipt;
}

function blocked(reason: string, target: TaskQaTargetReadiness["target"] = null,
  status: "blocked" | "unsupported" = "blocked"): TaskQaTargetReadiness {
  return Object.freeze({ status, reason, target, scheduleAllowed: false, qaPreparation: "unknown",
    qaExecution: "not-started", qaVerdict: "not-established" });
}

/**
 * Binds a CTO-received implementation commit to one exact current QA Task and Worker.
 * This only assesses readiness from trusted current-source/Host readers; it never schedules a run.
 */
export function bindAcceptedCommitToQaTask(input: Readonly<{
  acceptance: unknown;
  implementationPacket: TaskPacketRecord;
  qaPacket: TaskPacketRecord;
  currentPackets: readonly TaskPacketRecord[];
  workerRegistry: unknown;
  currentSourceRoot: unknown;
  currentBranchTip: unknown;
  protectedReceipt: unknown;
}>): TaskQaTargetReadiness {
  const acceptance = parseAcceptance(input.acceptance);
  const implementation = parseTaskPacketRecord(input.implementationPacket, acceptance.projectId, acceptance.ctoId, acceptance.workstreamId);
  const qa = parseTaskPacketRecord(input.qaPacket, acceptance.projectId, acceptance.ctoId, acceptance.workstreamId);
  const packets = input.currentPackets.map(packet => parseTaskPacketRecord(packet, acceptance.projectId, acceptance.ctoId, acceptance.workstreamId));
  const packetDigest = taskPacketRecordDigest(implementation, acceptance.projectId, acceptance.ctoId, acceptance.workstreamId);
  if (acceptance.workspaceId.trim() === "" || acceptance.taskId !== implementation.packet.taskId
    || acceptance.packetRevision !== implementation.packet.revision || acceptance.packetRecordSha256 !== packetDigest
    || acceptance.acceptanceId !== hash(["builder-task-source-acceptance-v1", acceptance.submissionId])) {
    return blocked("acceptance-does-not-bind-this-exact-implementation-packet");
  }
  if (implementation.packet.kind !== "development" || qa.packet.kind !== "qa"
    || qa.packet.taskId === implementation.packet.taskId || qa.packet.dependencies.includes(qa.packet.taskId)) {
    return blocked("distinct-development-and-qa-packets-required");
  }
  const currentImplementation = packets.find(packet => packet.packet.taskId === implementation.packet.taskId);
  const currentQa = packets.find(packet => packet.packet.taskId === qa.packet.taskId);
  if (!currentImplementation || !currentQa || taskPacketRecordDigest(currentImplementation, acceptance.projectId, acceptance.ctoId,
    acceptance.workstreamId) !== packetDigest || taskPacketRecordDigest(currentQa, acceptance.projectId, acceptance.ctoId,
    acceptance.workstreamId) !== taskPacketRecordDigest(qa, acceptance.projectId, acceptance.ctoId, acceptance.workstreamId)) {
    return blocked("implementation-or-qa-packet-is-not-the-exact-current-publication");
  }
  const dependency = qa.dependencyPins.find(pin => pin.taskId === implementation.packet.taskId);
  if (!dependency || dependency.revision !== implementation.packet.revision || dependency.recordSha256 !== packetDigest
    || acceptance.dependencyPins.some(pin => {
      const current = packets.find(packet => packet.packet.taskId === pin.taskId);
      return !current || current.packet.revision !== pin.revision
        || taskPacketRecordDigest(current, acceptance.projectId, acceptance.ctoId, acceptance.workstreamId) !== pin.recordSha256;
    })) return blocked("qa-dependency-or-accepted-dependency-pins-drifted");
  if (JSON.stringify(acceptance.dependencyPins) !== JSON.stringify(implementation.dependencyPins)) {
    return blocked("acceptance-dependency-pins-do-not-match-implementation-packet");
  }
  const source = implementation.packet.sourceAccess, qaSource = qa.packet.sourceAccess;
  if (!source || !qaSource || source.sourceId !== acceptance.source.sourceId || source.folderKey !== acceptance.source.folderKey
    || source.branch !== acceptance.source.branch || qaSource.sourceId !== acceptance.source.sourceId
    || qaSource.folderKey !== acceptance.source.folderKey || qaSource.branch !== acceptance.source.branch) {
    return blocked("qa-source-or-branch-does-not-match-accepted-commit");
  }
  let registry;
  try { registry = parseTaskWorkerRegistry(input.workerRegistry, acceptance.workspaceId, acceptance.projectId, acceptance.ctoId); }
  catch { return blocked("current-task-worker-registry-unavailable"); }
  const qaWorkers = registry.records.filter(record => record.workstreamId === acceptance.workstreamId
    && record.taskId === qa.packet.taskId && record.packetRevision === qa.packet.revision
    && record.packetRecordSha256 === taskPacketRecordDigest(qa, acceptance.projectId, acceptance.ctoId, acceptance.workstreamId)
    && record.role === "qa");
  if (qaWorkers.length !== 1) return blocked("exact-current-qa-worker-not-registered");
  const worker: TaskWorkerRecord = qaWorkers[0]!;
  try { deriveTaskWorkerFileBinding({ workspaceId: acceptance.workspaceId, projectId: acceptance.projectId, ctoId: acceptance.ctoId,
    packet: qa, currentPackets: packets, worker }); }
  catch { return blocked("qa-worker-or-disjoint-test-scope-is-not-current"); }

  const target = Object.freeze({ sourceId: acceptance.source.sourceId, folderKey: acceptance.source.folderKey,
    branch: acceptance.source.branch, commitSha: acceptance.commitSha, treeSha: acceptance.treeSha,
    implementationTaskId: implementation.packet.taskId, implementationPacketRevision: implementation.packet.revision,
    implementationPacketRecordSha256: packetDigest, qaTaskId: qa.packet.taskId, qaPacketRevision: qa.packet.revision,
    qaPacketRecordSha256: taskPacketRecordDigest(qa, acceptance.projectId, acceptance.ctoId, acceptance.workstreamId),
    qaWorkerAgentId: worker.agentId, qaWorkerSessionId: worker.sessionId });

  if (input.currentSourceRoot === null || input.currentSourceRoot === undefined) return blocked("current-source-root-proof-unavailable", target, "unsupported");
  const root = exactRecord(input.currentSourceRoot, ["sourceId", "folderKey", "match"], "Current Source root proof");
  if (root.sourceId !== target.sourceId || root.folderKey !== target.folderKey || root.match !== "same_root") {
    return blocked("current-source-root-does-not-match-accepted-source", target);
  }
  if (input.currentBranchTip === null || input.currentBranchTip === undefined) return blocked("current-branch-tip-proof-unavailable", target, "unsupported");
  const tip = exactRecord(input.currentBranchTip, ["sourceId", "branch", "commitSha", "treeSha"], "Current Git tip proof");
  if (tip.sourceId !== target.sourceId || tip.branch !== target.branch || tip.commitSha !== target.commitSha || tip.treeSha !== target.treeSha) {
    return blocked("accepted-commit-is-not-the-current-branch-tip", target);
  }
  if (input.protectedReceipt === null || input.protectedReceipt === undefined) return blocked("exact-protected-qa-receipt-unavailable", target, "unsupported");
  const protectedRun = exactRecord(input.protectedReceipt, ["schemaVersion", "kind", "id", "status", "termination", "pins", "qaVerdict"],
    "Protected QA receipt");
  const protectedPins = exactRecord(protectedRun.pins, ["approvalId", "sourceId", "planSha256", "profileSha256", "commitSha",
    "treeSha", "manifestSha256", "inputTreeSha256", "nodeSha256", "subjectKeySha256", "timeoutMs"], "Protected QA pins");
  if (protectedRun.schemaVersion !== 1 || protectedRun.kind !== "protected-node-test-v1" || typeof protectedRun.id !== "string"
    || !uuid.test(protectedRun.id) || !["queued", "claimed", "running", "cancelling", "succeeded", "failed", "cancelled"].includes(protectedRun.status as string)
    || !["not_applicable", "pending", "confirmed"].includes(protectedRun.termination as string)
    || protectedPins.sourceId !== target.sourceId || protectedPins.commitSha !== target.commitSha || protectedPins.treeSha !== target.treeSha
    || typeof protectedPins.subjectKeySha256 !== "string" || !SHA256.test(protectedPins.subjectKeySha256)
    || protectedRun.qaVerdict !== "not-established") {
    return blocked("protected-qa-receipt-does-not-match-accepted-source-commit", target);
  }
  return blocked("protected-run-subject-is-not-authoritatively-bound-to-this-qa-task", target, "unsupported");
}
