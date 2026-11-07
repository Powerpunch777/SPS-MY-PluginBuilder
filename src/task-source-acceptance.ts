import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey, type TaskWorkerRecord } from "./domain/task-workers.ts";
import { taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { exactToolRecord, parseLeadToolContext } from "./lead-tool-authority.ts";
import { resolveCtoTaskAuthority } from "./task-packet-tools.ts";
import { readTaskSourceSubmission, type TaskSourceSubmission, type TaskSourceSubmissionBinding } from "./task-source-submissions.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "./task-worker-runtime.ts";
import type { RevisionState } from "./solution-revision-store.ts";

const SHA = /^[a-f0-9]{64}$/u;
const bounded = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded identifier.`);
  }
  return value;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const json = (value: unknown) => value as JsonValue;

type CtoTaskSourceAcceptance = Readonly<{
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
  dependencyPins: TaskSourceSubmissionBinding["dependencyPins"];
  source: TaskSourceSubmissionBinding["source"];
  commitSha: string;
  treeSha: string;
  changedPaths: readonly string[];
  receivedBy: Readonly<{ agentId: string; sessionId: string; runId: string }>;
  receivedAt: string;
  meaning: "cto-received-exact-submitted-commit";
}>;

export type CurrentTaskSourceAcceptanceAuthority = Readonly<{
  workspaceId: string;
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  ctoAgentId: string;
  ctoSessionId: string;
  ctoRunId: string;
  task: TaskPacketRecord;
  packetDigest: string;
  packets: readonly TaskPacketRecord[];
  workerRecords: readonly TaskWorkerRecord[];
  submissionCandidates: readonly Readonly<{ task: TaskPacketRecord; packetDigest: string; packets: readonly TaskPacketRecord[];
    worker: TaskWorkerRecord; current: boolean }>[];
  dependencyPins: TaskSourceSubmissionBinding["dependencyPins"];
  assertCurrent(): Promise<void>;
}>;
type Current = CurrentTaskSourceAcceptanceAuthority;

function taskRegistryKey(workspaceId: string, projectId: string, ctoId: string) {
  return { scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder",
    stateKey: taskWorkerRegistryKey(projectId, ctoId) };
}

function submissionBinding(current: Current, task: TaskPacketRecord, packetDigest: string,
  worker: TaskWorkerRecord): Omit<TaskSourceSubmissionBinding, "runId"> {
  const access = task.packet.sourceAccess;
  if (!access?.branch || !access.expectedHead) throw new Error("Task source branch/head pins are not explicit.");
  return Object.freeze({ schemaVersion: 1, workspaceId: current.workspaceId, projectId: current.projectId,
    ctoId: current.ctoId, workstreamId: current.workstreamId, taskId: task.packet.taskId,
    packetRevision: task.packet.revision, packetRecordSha256: packetDigest,
    dependencyPins: task.dependencyPins, role: worker.role, agentId: worker.agentId, sessionId: worker.sessionId,
    source: Object.freeze({ sourceId: access.sourceId, folderKey: access.folderKey, branch: access.branch,
      expectedHead: access.expectedHead }), readPaths: access.readPaths, writePaths: access.writePaths, qaWritePaths: access.qaWritePaths });
}

async function resolveCurrent(input: { projectId: string; ctoId: string; workstreamId: string; taskId: string }, runContext: unknown,
  platform: SpsPlatformInvocationContext, toolName: string): Promise<Current> {
  const context = parseLeadToolContext(runContext);
  const authority = await resolveCtoTaskAuthority(input.projectId, input.ctoId, input.workstreamId, context, platform, toolName);
  const board = await authority.store.current();
  const history = await authority.store.recent(50);
  const task = board?.revision.packets.find(row => row.packet.taskId === input.taskId);
  if (!task) throw new Error("The exact current published Task Packet is unavailable.");
  const packetDigest = taskPacketRecordDigest(task, input.projectId, input.ctoId, input.workstreamId);
  const packets = board!.revision.packets;
  const dependenciesCurrent = task.dependencyPins.every(pin => {
    const dependency = packets.find(row => row.packet.taskId === pin.taskId);
    return dependency?.packet.revision === pin.revision
      && taskPacketRecordDigest(dependency, input.projectId, input.ctoId, input.workstreamId) === pin.recordSha256;
  });
  if (!dependenciesCurrent) throw new Error("Current Task Packet dependency pins have drifted.");
  const rawRegistry = await authority.state.get(taskRegistryKey(context.companyId, input.projectId, input.ctoId));
  const registry = parseTaskWorkerRegistry(rawRegistry ?? { schemaVersion: 1, workspaceId: context.companyId,
    projectId: input.projectId, ctoId: input.ctoId, revision: 0, records: [] }, context.companyId, input.projectId, input.ctoId);
  const workerRecords = registry.records.filter(record => record.workstreamId === input.workstreamId
    && record.taskId === input.taskId && record.packetRevision === task!.packet.revision
    && record.packetRecordSha256 === packetDigest && record.source.requestId === task!.source.requestId
    && record.source.specRevision === task!.source.specRevision && record.source.instructionSha256 === task!.source.instructionSha256);
  const packetBoards = history.revisions.map(entry => entry.revision);
  const submissionCandidates: Array<{ task: TaskPacketRecord; packetDigest: string; packets: readonly TaskPacketRecord[];
    worker: TaskWorkerRecord; current: boolean }> = [];
  for (const historicalBoard of packetBoards) {
    const historicalTask = historicalBoard.packets.find(row => row.packet.taskId === input.taskId);
    if (!historicalTask) continue;
    const historicalDigest = taskPacketRecordDigest(historicalTask, input.projectId, input.ctoId, input.workstreamId);
    const historicalWorkers = registry.records.filter(record => record.workstreamId === input.workstreamId
      && record.taskId === input.taskId && record.packetRevision === historicalTask.packet.revision
      && record.packetRecordSha256 === historicalDigest && record.source.requestId === historicalTask.source.requestId
      && record.source.specRevision === historicalTask.source.specRevision
      && record.source.instructionSha256 === historicalTask.source.instructionSha256);
    for (const worker of historicalWorkers) {
      if (!submissionCandidates.some(candidate => candidate.packetDigest === historicalDigest && candidate.worker.role === worker.role
        && candidate.worker.agentId === worker.agentId && candidate.worker.sessionId === worker.sessionId)) {
        submissionCandidates.push({ task: historicalTask, packetDigest: historicalDigest, packets: historicalBoard.packets,
          worker, current: historicalDigest === packetDigest });
      }
    }
  }
  const check = async () => {
    await authority.check();
    const latest = await authority.store.current();
    const currentTask = latest?.revision.packets.find(row => row.packet.taskId === input.taskId);
    if (!currentTask || taskPacketRecordDigest(currentTask, input.projectId, input.ctoId, input.workstreamId) !== packetDigest
      || currentTask.dependencyPins.some(pin => {
        const dependency = latest!.revision.packets.find(row => row.packet.taskId === pin.taskId);
        return !dependency || dependency.packet.revision !== pin.revision
          || taskPacketRecordDigest(dependency, input.projectId, input.ctoId, input.workstreamId) !== pin.recordSha256;
      })) throw new Error("Task Packet or dependency changed during submission intake.");
    const rawLatest = await authority.state.get(taskRegistryKey(context.companyId, input.projectId, input.ctoId));
    if (JSON.stringify(rawLatest) !== JSON.stringify(rawRegistry)) throw new Error("Task Worker registration changed during submission intake.");
    await authority.check();
  };
  await check();
  return Object.freeze({ workspaceId: context.companyId, projectId: input.projectId, ctoId: input.ctoId,
    workstreamId: input.workstreamId, taskId: input.taskId, ctoAgentId: context.agentId, ctoSessionId: context.sessionId,
    ctoRunId: context.runId,
    task, packetDigest, packets: Object.freeze(packets),
    workerRecords: Object.freeze(workerRecords), submissionCandidates: Object.freeze(submissionCandidates),
    dependencyPins: task.dependencyPins, assertCurrent: check });
}

type ExactSubmissionRead = Readonly<{ status: "submitted"; submission: TaskSourceSubmission; historical: boolean }>
  | Readonly<{ status: "not-found" }>
  | Readonly<{ status: "ineligible"; reason: "not-a-definitive-submission" | "legacy-receipt-unbound-paths" }>;

async function readExactSubmission(current: Current, submissionId: string, platform: SpsPlatformInvocationContext): Promise<ExactSubmissionRead> {
  const rawState = platform.state as typeof platform.state & RevisionState;
  let lookup: ReturnType<RevisionState["get"]> | undefined;
  const state: RevisionState = {
    get: key => lookup ??= (async () => {
      await current.assertCurrent();
      const result = await rawState.get(key);
      await current.assertCurrent();
      return result;
    })(),
  };
  const candidates = current.submissionCandidates.map(candidate => readTaskSourceSubmission({ state,
    binding: submissionBinding(current, candidate.task, candidate.packetDigest, candidate.worker), submissionId }));
  const results = await Promise.all(candidates);
  const receipts = results.filter((result): result is Extract<ExactSubmissionRead, { status: "submitted" }> => result.status === "submitted");
  if (receipts.length > 1) throw new Error("One submission ID resolved to multiple current Task roles.");
  if (receipts.length === 1) {
    const candidate = current.submissionCandidates.find(item => item.worker.role === receipts[0]!.submission.role
      && item.worker.agentId === receipts[0]!.submission.producer.agentId && item.worker.sessionId === receipts[0]!.submission.producer.sessionId
      && item.packetDigest === receipts[0]!.submission.packetRecordSha256);
    return Object.freeze({ status: "submitted" as const, submission: receipts[0]!.submission,
      historical: !candidate?.current });
  }
  if (results.some(result => result.status === "ineligible")) return results.find(result => result.status === "ineligible")!;
  return { status: "not-found" as const };
}

function acceptanceKey(workspaceId: string, submissionId: string) {
  return { scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder",
    stateKey: `task-source-acceptance.v1.${submissionId}` };
}

function parseAcceptance(value: unknown, submission: TaskSourceSubmission): CtoTaskSourceAcceptance {
  const row = exactToolRecord(value, ["schemaVersion", "acceptanceId", "submissionId", "workspaceId", "projectId", "ctoId",
    "workstreamId", "taskId", "packetRevision", "packetRecordSha256", "dependencyPins", "source", "commitSha", "treeSha",
    "changedPaths", "receivedBy", "receivedAt", "meaning"]);
  const receivedBy = exactToolRecord(row.receivedBy, ["agentId", "sessionId", "runId"]);
  const expectedId = digest(["builder-task-source-acceptance-v1", submission.submissionId]);
  if (row.schemaVersion !== 1 || row.acceptanceId !== expectedId || row.submissionId !== submission.submissionId
    || row.workspaceId !== submission.workspaceId || row.projectId !== submission.projectId || row.ctoId !== submission.ctoId
    || row.workstreamId !== submission.workstreamId || row.taskId !== submission.taskId
    || row.packetRevision !== submission.packetRevision || row.packetRecordSha256 !== submission.packetRecordSha256
    || JSON.stringify(row.dependencyPins) !== JSON.stringify(submission.dependencyPins)
    || JSON.stringify(row.source) !== JSON.stringify(submission.source) || row.commitSha !== submission.commitSha
    || row.treeSha !== submission.treeSha || JSON.stringify(row.changedPaths) !== JSON.stringify(submission.changedPaths)
    || ![receivedBy.agentId, receivedBy.sessionId, receivedBy.runId].every(item => typeof item === "string"
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(item))
    || typeof row.receivedAt !== "string" || !Number.isFinite(Date.parse(row.receivedAt))
    || row.meaning !== "cto-received-exact-submitted-commit") throw new Error("Stored CTO acceptance is not the exact immutable submission receipt.");
  return Object.freeze({ schemaVersion: 1, acceptanceId: expectedId, submissionId: submission.submissionId,
    workspaceId: submission.workspaceId, projectId: submission.projectId, ctoId: submission.ctoId,
    workstreamId: submission.workstreamId, taskId: submission.taskId, packetRevision: submission.packetRevision,
    packetRecordSha256: submission.packetRecordSha256, dependencyPins: submission.dependencyPins, source: submission.source,
    commitSha: submission.commitSha, treeSha: submission.treeSha, changedPaths: submission.changedPaths,
    receivedBy: Object.freeze({ agentId: receivedBy.agentId as string, sessionId: receivedBy.sessionId as string,
      runId: receivedBy.runId as string }), receivedAt: row.receivedAt, meaning: "cto-received-exact-submitted-commit" });
}

async function verifyProducerRun(current: Current, submission: TaskSourceSubmission, platform: SpsPlatformInvocationContext) {
  const worker = current.workerRecords.find(record => record.role === submission.role && record.agentId === submission.producer.agentId
    && record.sessionId === submission.producer.sessionId);
  if (!worker) throw new Error("Submitted source producer is not the current exact registered Task role.");
  const binding = deriveTaskWorkerFileBinding({ workspaceId: current.workspaceId, projectId: current.projectId, ctoId: current.ctoId,
    packet: current.task, currentPackets: current.packets, worker });
  const sessions = platform.agents.sessions as typeof platform.agents.sessions & {
    getRequest?: (sessionId: string, companyId: string, requestId: string) => Promise<unknown>;
    getRun?: (sessionId: string, companyId: string, runId: string) => Promise<unknown>;
  };
  if (typeof sessions.getRequest !== "function" || typeof sessions.getRun !== "function") return "unsupported" as const;
  const requestId = taskWorkerRequestId(binding);
  await current.assertCurrent();
  const request = await sessions.getRequest(worker.sessionId, current.workspaceId, requestId);
  await current.assertCurrent();
  const receipt = request === null ? null : exactToolRecord(request, ["requestId", "state", "runId"]);
  if (!receipt || receipt.requestId !== requestId || receipt.state !== "submitted" || receipt.runId !== submission.producer.runId) {
    throw new Error("Submitted source receipt has no exact authoritative Task dispatch Run receipt.");
  }
  const run = await sessions.getRun(worker.sessionId, current.workspaceId, submission.producer.runId);
  await current.assertCurrent();
  const runRow = run && typeof run === "object" ? exactToolRecord(run, ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"], ["execution", "output"]) : null;
  if (!runRow || runRow.runId !== submission.producer.runId || typeof runRow.status !== "string"
    || !["running", "succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(runRow.status)) {
    throw new Error("Task producer Run identity could not be verified.");
  }
  return "producer-run-observed" as const;
}

function staleReason(current: Current, submission: TaskSourceSubmission): string | null {
  const access = current.task.packet.sourceAccess;
  if (!access || !access.branch || !access.expectedHead || submission.authorityAfterCommit !== "current"
    || submission.workspaceId !== current.workspaceId || submission.projectId !== current.projectId || submission.ctoId !== current.ctoId
    || submission.workstreamId !== current.workstreamId || submission.taskId !== current.taskId
    || submission.packetRevision !== current.task.packet.revision || submission.packetRecordSha256 !== current.packetDigest
    || JSON.stringify(submission.dependencyPins) !== JSON.stringify(current.dependencyPins)
    || submission.source.sourceId !== access.sourceId || submission.source.folderKey !== access.folderKey
    || submission.source.branch !== access.branch || submission.source.expectedHead !== access.expectedHead) return "task-source-or-authority-pins-changed";
  return null;
}

export async function recordCtoTaskSourceAcceptance(input: Readonly<{
  current: Current;
  submission: TaskSourceSubmission;
  receiver: Readonly<{ workspaceId: string; projectId: string; ctoId: string; agentId: string; sessionId: string; runId: string }>;
  state: RevisionState;
}>): Promise<Readonly<{ status: "accepted" | "existing" | "stale" | "unsupported" | "unknown";
  acceptance?: CtoTaskSourceAcceptance; reason?: string }>> {
  const { current, submission, receiver, state } = input;
  const stale = staleReason(current, submission);
  if (stale) return Object.freeze({ status: "stale", reason: stale });
  if (receiver.workspaceId !== current.workspaceId || receiver.projectId !== current.projectId || receiver.ctoId !== current.ctoId
    || receiver.agentId !== current.ctoAgentId || receiver.sessionId !== current.ctoSessionId || receiver.runId !== current.ctoRunId
    || ![receiver.agentId, receiver.sessionId, receiver.runId].every(value => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value))) {
    throw new Error("Only the exact current CTO Agent, session and active Run may accept this submission.");
  }
  await current.assertCurrent();
  const key = acceptanceKey(current.workspaceId, submission.submissionId);
  const guardedState: RevisionState = {
    get: async stateKey => { await current.assertCurrent(); const value = await state.get(stateKey); await current.assertCurrent(); return value; },
    compareAndSet: state.compareAndSet ? async (...args) => {
      await current.assertCurrent(); const value = await state.compareAndSet!(...args); await current.assertCurrent(); return value;
    } : undefined,
  };
  const existing = await guardedState.get(key);
  if (existing !== null) return Object.freeze({ status: "existing", acceptance: parseAcceptance(existing, submission) });
  if (typeof guardedState.compareAndSet !== "function") return Object.freeze({ status: "unsupported",
    reason: "atomic-cto-submission-acceptance-unavailable" });
  const acceptanceId = digest(["builder-task-source-acceptance-v1", submission.submissionId]);
  const acceptance: CtoTaskSourceAcceptance = Object.freeze({ schemaVersion: 1, acceptanceId,
    submissionId: submission.submissionId, workspaceId: current.workspaceId, projectId: current.projectId,
    ctoId: current.ctoId, workstreamId: current.workstreamId, taskId: current.taskId,
    packetRevision: submission.packetRevision, packetRecordSha256: submission.packetRecordSha256,
    dependencyPins: submission.dependencyPins, source: submission.source, commitSha: submission.commitSha,
    treeSha: submission.treeSha, changedPaths: submission.changedPaths,
    receivedBy: Object.freeze({ agentId: receiver.agentId, sessionId: receiver.sessionId, runId: receiver.runId }),
    receivedAt: new Date().toISOString(), meaning: "cto-received-exact-submitted-commit" });
  let swapped = false;
  try { swapped = (await guardedState.compareAndSet(key, { exists: false }, json(acceptance))).swapped; }
  catch {
    // Read the existing receipt after a lost reply, never repeat the write.
    await current.assertCurrent();
  }
  if (!swapped) {
    const raced = await guardedState.get(key);
    if (raced !== null) return Object.freeze({ status: "existing", acceptance: parseAcceptance(raced, submission) });
    return Object.freeze({ status: "unknown", reason: "acceptance-cas-conflict-unresolved" });
  }
  return Object.freeze({ status: "accepted", acceptance });
}

async function sourceRootCurrent(submission: TaskSourceSubmission, platform: SpsPlatformInvocationContext) {
  const folders = (platform as SpsPlatformInvocationContext & { localFolders?: {
    matchWorkspaceSourceV1?: (folderKey: string, sourceId: string) => Promise<unknown>;
  } }).localFolders;
  if (typeof folders?.matchWorkspaceSourceV1 !== "function") return "unsupported" as const;
  const raw = await folders.matchWorkspaceSourceV1(submission.source.folderKey, submission.source.sourceId);
  const match = exactToolRecord(raw, ["folderKey", "workspaceSourceId", "match"]);
  if (match.folderKey !== submission.source.folderKey || match.workspaceSourceId !== submission.source.sourceId
    || match.match !== "same_root") return "stale" as const;
  return "current" as const;
}

type IntakeResult = Readonly<{
  status: "submitted" | "accepted" | "existing" | "stale" | "unsupported" | "unknown";
  submissionId: string;
  submission?: TaskSourceSubmission;
  acceptance?: CtoTaskSourceAcceptance;
  reason?: string;
  qaPreparation: "ready" | "not-prepared" | "not-applicable" | "unknown";
  qaExecution: "not-started" | "started" | "not-applicable" | "unknown";
  qaVerdict: "not-established";
}>;

async function intake(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext, accept: boolean): Promise<IntakeResult> {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "taskId", "submissionId"]);
  const projectId = bounded(input.projectId, "projectId"), ctoId = bounded(input.ctoId, "ctoId");
  const workstreamId = bounded(input.workstreamId, "workstreamId"), taskId = bounded(input.taskId, "taskId");
  if (typeof input.submissionId !== "string" || !SHA.test(input.submissionId)) throw new TypeError("submissionId must be a SHA-256 identifier.");
  const submissionId = input.submissionId;
  const toolName = accept ? "builder.accept-task-source-submission" : "builder.read-task-source-submissions";
  const current = await resolveCurrent({ projectId, ctoId, workstreamId, taskId }, runContext, platform, toolName);
  await current.assertCurrent();
  const submissionRead = await readExactSubmission(current, submissionId, platform);
  if (submissionRead.status !== "submitted") return Object.freeze({ status: "unknown",
    submissionId, reason: submissionRead.status === "not-found" ? "submission-not-found" : submissionRead.reason,
    qaPreparation: "unknown", qaExecution: "unknown", qaVerdict: "not-established" });
  const submission = submissionRead.submission;
  if (submissionRead.historical) return Object.freeze({ status: "stale", submissionId, submission,
    reason: "task-packet-or-dependency-revision-superseded",
    qaPreparation: submission.role === "qa" ? "unknown" : "not-applicable",
    qaExecution: submission.role === "qa" ? "unknown" : "not-applicable", qaVerdict: "not-established" });
  const stale = staleReason(current, submission);
  if (stale) return Object.freeze({ status: "stale", submissionId, submission, reason: stale,
    qaPreparation: submission.role === "qa" ? "unknown" : "not-applicable",
    qaExecution: submission.role === "qa" ? "unknown" : "not-applicable", qaVerdict: "not-established" });
  const sourceState = await sourceRootCurrent(submission, platform);
  await current.assertCurrent();
  if (sourceState !== "current") return Object.freeze({ status: sourceState === "unsupported" ? "unsupported" : "stale",
    submissionId, submission, reason: sourceState === "unsupported" ? "source-root-match-api-unavailable" : "task-source-root-changed",
    qaPreparation: submission.role === "qa" ? "unknown" : "not-applicable",
    qaExecution: submission.role === "qa" ? "unknown" : "not-applicable", qaVerdict: "not-established" });
  const runState = await verifyProducerRun(current, submission, platform);
  if (runState === "unsupported") return Object.freeze({ status: "unsupported", submissionId, submission,
    reason: "task-session-run-receipt-api-unavailable", qaPreparation: submission.role === "qa" ? "unknown" : "not-applicable",
    qaExecution: submission.role === "qa" ? "unknown" : "not-applicable", qaVerdict: "not-established" });
  await current.assertCurrent();
  const state = platform.state as typeof platform.state & RevisionState;
  const key = acceptanceKey(current.workspaceId, submissionId);
  const guardedState: RevisionState = {
    get: async stateKey => { await current.assertCurrent(); const value = await state.get(stateKey); await current.assertCurrent(); return value; },
  };
  const existing = await guardedState.get(key);
  if (existing !== null) {
    const acceptance = parseAcceptance(existing, submission);
    return Object.freeze({ status: accept ? "existing" : "accepted", submissionId, submission, acceptance,
      qaPreparation: submission.role === "qa" ? "unknown" : "not-applicable",
      qaExecution: submission.role === "qa" ? "unknown" : "not-applicable", qaVerdict: "not-established" });
  }
  if (!accept) return Object.freeze({ status: "submitted", submissionId, submission,
    qaPreparation: submission.role === "qa" ? "unknown" : "not-applicable",
    qaExecution: submission.role === "qa" ? "unknown" : "not-applicable", qaVerdict: "not-established" });
  const context = parseLeadToolContext(runContext);
  const saved = await recordCtoTaskSourceAcceptance({ current, submission,
    receiver: { workspaceId: context.companyId, projectId, ctoId, agentId: context.agentId, sessionId: context.sessionId,
      runId: context.runId }, state });
  return Object.freeze({ ...saved, submissionId, submission,
    qaPreparation: submission.role === "qa" ? "unknown" : "not-applicable",
    qaExecution: submission.role === "qa" ? "unknown" : "not-applicable", qaVerdict: "not-established" });
}

export async function readCtoTaskSourceSubmission(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  return intake(params, runContext, platform, false);
}

export async function acceptCtoTaskSourceSubmission(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  return intake(params, runContext, platform, true);
}
