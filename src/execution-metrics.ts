import type { JsonValue, SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey, type TaskWorkerRecord } from "./domain/task-workers.ts";
import { taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { exactToolRecord } from "./lead-tool-authority.ts";
import { readProjectCtos } from "./project-cto-tools.ts";
import { createTaskPacketStore } from "./task-packet-tools.ts";
import { deriveTaskWorkerFileBinding, readTaskWorkerSessionRun } from "./task-worker-runtime.ts";
import { readCtoTaskSourceAcceptanceForSubmission } from "./task-source-acceptance.ts";
import { readTaskSourceClaim, type TaskSourceSubmissionBinding } from "./task-source-submissions.ts";
import type { RevisionState } from "./solution-revision-store.ts";
import { readWorkstreams } from "./workstream-tools.ts";
import { workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { createTaskQaRunReferenceStore, type TaskQaRunReference } from "./task-qa-run-references.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_RUNS = 128;
type Timing = Readonly<{ createdAt: string; startedAt: string | null; finishedAt: string | null }>;
export type WorkerExecutionMetric = Readonly<{ ctoId: string; workstreamId: string; taskId: string; role: "worker" | "qa";
  packetRevision: number; requestId: string; runId: string | null; runStatus: string;
  normalEnded: boolean; timing: Timing | null; queueMs: number | null; executionMs: number | null; reason: string | null;
  commitAcceptanceMs: number | null }>;
export type ExecutionMetrics = Readonly<{ status: "ready"; workspaceId: string; projectId: string; observedAt: string;
  consistency: "rechecked-current-records-not-a-global-transaction";
  runs: readonly WorkerExecutionMetric[]; summary: Readonly<{ observedRuns: number; normalEndedRuns: number;
    measuredRuns: number; totalExecutionMs: number | null; totalQueueMs: number | null;
    commitAcceptanceCount: number; totalCommitAcceptanceMs: number | null }>;
  unmeasured: Readonly<{ taskCompletionMs: null; permissionWaitMs: null; integrationWaitMs: null;
    reworkCount: null; manualInterventionCount: null }>; completionAuthority: "not-established" }>;

function unmeasuredQaContinuation(input: Readonly<{ ctoId: string; workstreamId: string; taskId: string; packetRevision: number;
  requestId: string; reason: string; runId?: string | null; runStatus?: string }>): WorkerExecutionMetric {
  return { ctoId: input.ctoId, workstreamId: input.workstreamId, taskId: input.taskId, role: "qa",
    packetRevision: input.packetRevision, requestId: input.requestId, runId: input.runId ?? null,
    runStatus: input.runStatus ?? "unknown", normalEnded: false, timing: null, queueMs: null, executionMs: null,
    reason: input.reason, commitAcceptanceMs: null };
}

function ownData(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

async function currentQaContinuationMetric(input: Readonly<{ workspaceId: string; ctoId: string; workstreamId: string;
  packet: TaskPacketRecord; packets: readonly TaskPacketRecord[]; worker: TaskWorkerRecord; requestId: string;
  originalRunId: string | null; platform: SpsPlatformInvocationContext; seenRuns: Set<string> }>): Promise<WorkerExecutionMetric | null> {
  if (input.worker.role !== "qa") return null;
  const fallback = (reason: string, runStatus = "unknown", runId: string | null = null) => unmeasuredQaContinuation({
    ctoId: input.ctoId, workstreamId: input.workstreamId, taskId: input.worker.taskId,
    packetRevision: input.worker.packetRevision, requestId: input.requestId, reason, runStatus, runId,
  });
  const scope = { workspaceId: input.workspaceId, projectId: input.workspaceId, ctoId: input.ctoId,
    workstreamId: input.workstreamId, qaTaskId: input.worker.taskId };
  let reference: TaskQaRunReference | undefined;
  try { reference = (await createTaskQaRunReferenceStore(scope, input.platform.state as typeof input.platform.state & RevisionState).current())?.revision; }
  catch { return fallback("qa-continuation-current-reference-unavailable", "unsupported"); }
  if (!reference?.deferredEvent) return null;
  const { binding, deferredEvent } = reference;
  const sourceAccess = input.packet.packet.sourceAccess;
  const implementation = input.packets.find(row => row.packet.taskId === binding.implementationTaskId);
  const dependency = input.packet.dependencyPins.find(pin => pin.taskId === binding.implementationTaskId);
  if (input.packet.packet.kind !== "qa" || input.packet.packet.revision !== binding.qaRevision
    || input.packet.packet.taskId !== scope.qaTaskId || input.worker.agentId !== binding.qaAgentId
    || input.worker.sessionId !== binding.qaSessionId || input.worker.packetRecordSha256 !== binding.qaDigest
    || !sourceAccess || sourceAccess.sourceId !== binding.sourceId
    || sourceAccess.folderKey !== binding.folderKey || sourceAccess.branch !== binding.branch
    || !implementation || implementation.packet.kind !== "development"
    || implementation.packet.revision !== binding.implementationRevision
    || taskPacketRecordDigest(implementation, input.workspaceId, input.ctoId, input.workstreamId) !== binding.implementationDigest
    || !dependency || dependency.revision !== binding.implementationRevision || dependency.recordSha256 !== binding.implementationDigest
    || input.originalRunId === null || deferredEvent.previousRunId !== input.originalRunId) {
    return fallback("qa-continuation-current-task-or-reference-mismatch");
  }

  const sessions = input.platform.agents.sessions as typeof input.platform.agents.sessions & {
    list?: (agentId: string, companyId: string) => Promise<unknown[]>;
    getRequest?: (sessionId: string, companyId: string, requestId: string) => Promise<unknown>;
    getRun?: (sessionId: string, companyId: string, runId: string) => Promise<unknown>;
  };
  if (typeof sessions.list !== "function" || typeof sessions.getRequest !== "function" || typeof sessions.getRun !== "function") {
    return fallback("qa-continuation-session-registry-or-run-reader-unavailable", "unsupported");
  }

  try {
    const packetStore = await createTaskPacketStore(input.workspaceId, input.workspaceId, input.ctoId,
      input.workstreamId, input.platform.state as typeof input.platform.state & RevisionState).current();
    const currentPacket = packetStore?.revision.packets.find(row => row.packet.taskId === input.worker.taskId);
    const rawRegistry = await input.platform.state.get({ scopeKind: "company", scopeId: input.workspaceId,
      namespace: "sonpark.my-builder", stateKey: taskWorkerRegistryKey(input.workspaceId, input.ctoId) });
    const currentRegistry = parseTaskWorkerRegistry(rawRegistry ?? { schemaVersion: 1, workspaceId: input.workspaceId,
      projectId: input.workspaceId, ctoId: input.ctoId, revision: 0, records: [] }, input.workspaceId, input.workspaceId, input.ctoId);
    const currentWorker = currentRegistry.records.filter(row => row.workstreamId === input.workstreamId
      && row.taskId === input.worker.taskId && row.role === "qa");
    if (!currentPacket || currentPacket.packet.revision !== input.packet.packet.revision
      || taskPacketRecordDigest(currentPacket, input.workspaceId, input.ctoId, input.workstreamId)
        !== input.worker.packetRecordSha256 || currentWorker.length !== 1
      || JSON.stringify(currentWorker[0]) !== JSON.stringify(input.worker)) {
      return fallback("qa-continuation-current-task-or-role-changed");
    }
    const implementationWorker = currentRegistry.records.filter(row => row.workstreamId === input.workstreamId
      && row.taskId === implementation.packet.taskId && row.role === "worker"
      && row.packetRevision === implementation.packet.revision
      && row.packetRecordSha256 === binding.implementationDigest);
    const implementationAccess = implementation.packet.sourceAccess;
    if (implementationWorker.length !== 1 || !implementationAccess || typeof implementationAccess.sourceId !== "string"
      || typeof implementationAccess.folderKey !== "string" || typeof implementationAccess.branch !== "string"
      || typeof implementationAccess.expectedHead !== "string") return fallback("qa-continuation-current-implementation-source-unavailable");
    const implementationBinding: Omit<TaskSourceSubmissionBinding, "runId"> = Object.freeze({
      schemaVersion: 1, workspaceId: input.workspaceId, projectId: input.workspaceId, ctoId: input.ctoId,
      workstreamId: input.workstreamId, taskId: implementation.packet.taskId, packetRevision: implementation.packet.revision,
      packetRecordSha256: binding.implementationDigest, dependencyPins: implementation.dependencyPins, role: "worker",
      agentId: implementationWorker[0]!.agentId, sessionId: implementationWorker[0]!.sessionId,
      source: Object.freeze({ sourceId: implementationAccess.sourceId, folderKey: implementationAccess.folderKey,
        branch: implementationAccess.branch, expectedHead: implementationAccess.expectedHead }),
      readPaths: implementationAccess.readPaths, writePaths: implementationAccess.writePaths,
      qaWritePaths: implementationAccess.qaWritePaths,
    });
    const sourceClaim = await readTaskSourceClaim({ state: input.platform.state as RevisionState, binding: implementationBinding });
    if (sourceClaim.status !== "submitted" || sourceClaim.submission.submissionId !== binding.submissionId
      || sourceClaim.submission.commitSha !== binding.commitSha || sourceClaim.submission.treeSha !== binding.treeSha) {
      return fallback("qa-continuation-current-source-submission-mismatch");
    }
    const acceptance = await readCtoTaskSourceAcceptanceForSubmission({ workspaceId: input.workspaceId,
      submission: sourceClaim.submission, state: input.platform.state as RevisionState });
    if (!acceptance || acceptance.acceptanceId !== binding.acceptanceId || acceptance.submissionId !== binding.submissionId
      || acceptance.commitSha !== binding.commitSha || acceptance.treeSha !== binding.treeSha) {
      return fallback("qa-continuation-current-source-acceptance-mismatch");
    }
    const latestReference = (await createTaskQaRunReferenceStore(scope,
      input.platform.state as typeof input.platform.state & RevisionState).current())?.revision;
    if (latestReference?.revisionId !== reference.revisionId) return fallback("qa-continuation-reference-changed-during-read");

    const localFolders = (input.platform as SpsPlatformInvocationContext & { localFolders?: {
      readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown>;
    } }).localFolders;
    if (typeof localFolders?.readWorkspaceSourceGitTipV1 !== "function") {
      return fallback("qa-continuation-source-reader-unavailable", "unsupported");
    }
    const tip = await localFolders.readWorkspaceSourceGitTipV1(binding.sourceId, binding.folderKey, binding.branch);
    const tipRow = exactToolRecord(tip, ["status", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"]);
    if (tipRow.status !== "current" || tipRow.sourceId !== binding.sourceId || tipRow.folderKey !== binding.folderKey
      || tipRow.branch !== binding.branch || tipRow.commitSha !== binding.commitSha || tipRow.treeSha !== binding.treeSha) {
      return fallback("qa-continuation-source-changed");
    }

    const registryRows = await sessions.list(input.worker.agentId, input.workspaceId);
    if (!Array.isArray(registryRows) || registryRows.length > 100) return fallback("qa-continuation-session-registry-invalid");
    const matching = registryRows.filter(row => ownData(row, "sessionId") === input.worker.sessionId);
    if (matching.length !== 1) return fallback("qa-continuation-owned-session-not-unique");
    const row = matching[0];
    const sessionId = ownData(row, "sessionId"), agentId = ownData(row, "agentId"), companyId = ownData(row, "companyId");
    const status = ownData(row, "status"), closedAt = ownData(row, "closedAt"), lastRunId = ownData(row, "lastRunId");
    const taskKey = ownData(row, "taskKey");
    if (sessionId !== input.worker.sessionId || agentId !== input.worker.agentId || companyId !== input.workspaceId
      || taskKey !== `plugin:com.sonparkserver.my-plugin-builder:session:${input.worker.pluginAgentKey}`
      || status !== "active" || closedAt !== null || typeof lastRunId !== "string" || !UUID.test(lastRunId)) {
      return fallback("qa-continuation-owned-session-observation-mismatch");
    }
    if (lastRunId === input.originalRunId) return fallback("qa-continuation-run-not-yet-observed", "pending");

    const rawRun = await sessions.getRun(input.worker.sessionId, input.workspaceId, lastRunId);
    // Core's optional lineage projection is runtime-compatible with legacy SDKs but absent from fixed-c699 declarations.
    const run = exactToolRecord(rawRun, ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"],
      ["execution", "output", "timing", "systemEvent"]);
    const event = exactToolRecord(run.systemEvent, ["schemaVersion", "kind", "requestId", "previousRunId", "eventId",
      "protectedRunId", "receiptDigest", "subjectKeySha256"]);
    if (run.runId !== lastRunId || !UUID.test(lastRunId) || !UUID.test(String(event.requestId))
      || event.schemaVersion !== 1 || event.kind !== "protected-test-terminal-event"
      || event.previousRunId !== deferredEvent.previousRunId || event.eventId !== deferredEvent.eventId
      || event.protectedRunId !== binding.runId || event.receiptDigest !== deferredEvent.receiptDigest
      || event.subjectKeySha256 !== binding.subjectKeySha256) {
      return fallback("qa-continuation-core-lineage-unavailable");
    }
    const request = exactToolRecord(await sessions.getRequest(input.worker.sessionId, input.workspaceId, event.requestId as string),
      ["requestId", "state", "runId"]);
    if (request.requestId !== event.requestId || request.state !== "submitted" || request.runId !== lastRunId) {
      return fallback("qa-continuation-request-run-mismatch");
    }
    const registryAfterReads = await sessions.list(input.worker.agentId, input.workspaceId);
    const matchingAfterReads = Array.isArray(registryAfterReads) && registryAfterReads.length <= 100
      ? registryAfterReads.filter(item => ownData(item, "sessionId") === input.worker.sessionId) : [];
    if (matchingAfterReads.length !== 1 || ownData(matchingAfterReads[0], "agentId") !== input.worker.agentId
      || ownData(matchingAfterReads[0], "companyId") !== input.workspaceId
      || ownData(matchingAfterReads[0], "taskKey") !== taskKey || ownData(matchingAfterReads[0], "status") !== "active"
      || ownData(matchingAfterReads[0], "closedAt") !== null || ownData(matchingAfterReads[0], "lastRunId") !== lastRunId) {
      return fallback("qa-continuation-owned-session-changed-during-read");
    }
    const finalTip = exactToolRecord(await localFolders.readWorkspaceSourceGitTipV1(binding.sourceId, binding.folderKey, binding.branch),
      ["status", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"]);
    if (finalTip.status !== "current" || finalTip.sourceId !== binding.sourceId || finalTip.folderKey !== binding.folderKey
      || finalTip.branch !== binding.branch || finalTip.commitSha !== binding.commitSha || finalTip.treeSha !== binding.treeSha) {
      return fallback("qa-continuation-source-changed-during-read");
    }
    const latestAfterReads = (await createTaskQaRunReferenceStore(scope,
      input.platform.state as typeof input.platform.state & RevisionState).current())?.revision;
    if (latestAfterReads?.revisionId !== reference.revisionId) return fallback("qa-continuation-reference-changed-during-read");
    if (input.seenRuns.has(lastRunId)) return null;
    if (typeof run.status !== "string" || !["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status)
      || typeof run.cancellationRequested !== "boolean" || !["not_applicable", "pending", "confirmed"].includes(String(run.termination))) {
      return fallback("qa-continuation-run-status-invalid", "unknown", lastRunId);
    }
    const observedAt = new Date().toISOString();
    const timingDescriptor = Object.getOwnPropertyDescriptor(rawRun, "timing");
    const timing = timingDescriptor?.enumerable && Object.hasOwn(timingDescriptor, "value")
      ? readExecutionTiming(timingDescriptor.value, run.status, observedAt) : null;
    input.seenRuns.add(lastRunId);
    return { ctoId: input.ctoId, workstreamId: input.workstreamId, taskId: input.worker.taskId, role: "qa",
      packetRevision: input.worker.packetRevision, requestId: event.requestId as string, runId: lastRunId, runStatus: run.status,
      normalEnded: run.status === "succeeded" && run.cancellationRequested === false && run.termination === "not_applicable",
      timing: timing?.timing ?? null, queueMs: timing?.queueMs ?? null, executionMs: timing?.executionMs ?? null,
      reason: timing ? null : "host-run-timing-unavailable-or-inconsistent", commitAcceptanceMs: null };
  } catch { return fallback("qa-continuation-run-or-lineage-observation-unavailable"); }
}

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

async function currentCommitAcceptanceMs(input: Readonly<{ workspaceId: string; projectId: string; ctoId: string;
  workstreamId: string; packet: TaskPacketRecord; worker: TaskWorkerRecord; packets: readonly TaskPacketRecord[];
  platform: SpsPlatformInvocationContext; assertCurrent(): Promise<void> }>): Promise<number | null> {
  if (input.worker.role !== "worker" || !input.packet?.packet.sourceAccess?.branch || !input.packet.packet.sourceAccess.expectedHead) return null;
  try {
    const packetDigest = taskPacketRecordDigest(input.packet, input.projectId, input.ctoId, input.workstreamId);
    if (packetDigest !== input.worker.packetRecordSha256 || input.packet.packet.kind !== "development"
      || input.packet.packet.revision !== input.worker.packetRevision
      || input.packet.dependencyPins.some(pin => {
        const dependency = input.packets.find(row => row.packet.taskId === pin.taskId);
        return !dependency || dependency.packet.revision !== pin.revision
          || taskPacketRecordDigest(dependency, input.projectId, input.ctoId, input.workstreamId) !== pin.recordSha256;
      })) return null;
    const access = input.packet.packet.sourceAccess;
    const branch = access.branch, expectedHead = access.expectedHead;
    if (typeof branch !== "string" || !branch || typeof expectedHead !== "string" || !expectedHead) return null;
    const binding: Omit<TaskSourceSubmissionBinding, "runId"> = Object.freeze({
      schemaVersion: 1, workspaceId: input.workspaceId, projectId: input.projectId, ctoId: input.ctoId,
      workstreamId: input.workstreamId, taskId: input.packet.packet.taskId, packetRevision: input.packet.packet.revision,
      packetRecordSha256: packetDigest, dependencyPins: input.packet.dependencyPins, role: input.worker.role,
      agentId: input.worker.agentId, sessionId: input.worker.sessionId,
      source: Object.freeze({ sourceId: access.sourceId, folderKey: access.folderKey, branch, expectedHead }),
      readPaths: access.readPaths, writePaths: access.writePaths, qaWritePaths: access.qaWritePaths,
    });
    const state = input.platform.state as typeof input.platform.state & RevisionState;
    const claim = await readTaskSourceClaim({ state, binding });
    await input.assertCurrent();
    if (claim.status !== "submitted") return null;
    const submission = claim.submission;
    if (submission.role !== "worker" || submission.authorityAfterCommit !== "current"
      || submission.workspaceId !== input.workspaceId || submission.projectId !== input.projectId
      || submission.ctoId !== input.ctoId || submission.workstreamId !== input.workstreamId
      || submission.taskId !== input.packet.packet.taskId || submission.packetRevision !== input.packet.packet.revision
      || submission.packetRecordSha256 !== packetDigest) return null;
    const acceptance = await readCtoTaskSourceAcceptanceForSubmission({ workspaceId: input.workspaceId, submission, state });
    await input.assertCurrent();
    if (!acceptance || acceptance.submissionId !== submission.submissionId || acceptance.commitSha !== submission.commitSha
      || acceptance.treeSha !== submission.treeSha || acceptance.workspaceId !== input.workspaceId
      || acceptance.projectId !== input.projectId || acceptance.ctoId !== input.ctoId
      || acceptance.workstreamId !== input.workstreamId || acceptance.taskId !== input.packet.packet.taskId
      || acceptance.packetRevision !== input.packet.packet.revision || acceptance.packetRecordSha256 !== packetDigest
      || instant(submission.submittedAt) === null || instant(acceptance.receivedAt) === null) return null;
    const submittedAt = instant(submission.submittedAt)!, receivedAt = instant(acceptance.receivedAt)!;
    const observedAt = instant(new Date().toISOString());
    const elapsed = receivedAt - submittedAt;
    if (observedAt === null || submittedAt > receivedAt || receivedAt > observedAt || !Number.isSafeInteger(elapsed) || elapsed < 0) return null;
    return elapsed;
  } catch { return null; }
}

/** Missing Host timing is unmeasured, never a zero-duration execution. */
export function readExecutionTiming(value: unknown, runStatus: string, observedAt: string) {
  try {
    const row = exactToolRecord(value, ["createdAt", "startedAt", "finishedAt"]);
    const created = instant(row.createdAt), started = row.startedAt === null ? null : instant(row.startedAt);
    const finished = row.finishedAt === null ? null : instant(row.finishedAt), observed = instant(observedAt);
    if (created === null || observed === null || created > observed || row.startedAt !== null && started === null
      || row.finishedAt !== null && finished === null || started !== null && (started < created || started > observed)
      || finished !== null && (started === null || finished < started || finished > observed)
      || ["queued", "running"].includes(runStatus) && finished !== null) return null;
    const queueMs = started === null ? null : started - created;
    const executionMs = started === null || finished === null ? null : finished - started;
    if ([queueMs, executionMs].some(time => time !== null && !Number.isSafeInteger(time))) return null;
    return { timing: { createdAt: row.createdAt as string, startedAt: row.startedAt as string | null, finishedAt: row.finishedAt as string | null },
      queueMs, executionMs };
  } catch { return null; }
}

/** Read-only current Task/Worker observations. Run termination is not Task acceptance or QA. */
export async function readBuilderExecutionMetrics(workspaceId: string, platform: SpsPlatformInvocationContext): Promise<ExecutionMetrics
  | Readonly<{ status: "unknown"; reason: string }>> {
  if (!UUID.test(workspaceId)) throw new TypeError("Execution metrics require the current Workspace.");
  const heads = new Map<string, { key: SpsStateKey; value: JsonValue | null }>();
  const track = (scope: Set<string>) => ({ ...platform, state: { ...platform.state, async get(key: SpsStateKey) {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Metrics escaped their Workspace.");
    const value = await platform.state.get(key);
    if (!key.stateKey.includes("-revision.v1.")) {
      const identity = JSON.stringify([key.namespace ?? "default", key.stateKey]), previous = heads.get(identity);
      if (previous && JSON.stringify(previous.value) !== JSON.stringify(value)) throw new Error("Metrics source changed.");
      if (!previous) heads.set(identity, { key, value: structuredClone(value) });
      scope.add(identity);
    }
    return value;
  } } });
  const check = async (scope: Iterable<string> = heads.keys()) => {
    for (const identity of scope) {
      const { key, value } = heads.get(identity)!;
      if (JSON.stringify(await platform.state.get(key)) !== JSON.stringify(value)) throw new Error("Metrics source changed.");
    }
  };
  try {
    const sharedScope = new Set<string>(), tracked = track(sharedScope);
    const board = await readWorkstreams(workspaceId, workspaceId, tracked), ctos = await readProjectCtos(workspaceId, workspaceId, tracked);
    if ((board?.revision.workstreams.length ?? 0) > 64 || ctos.ctos.length > 64) return { status: "unknown", reason: "metrics-scope-over-bound" };
    const runs: WorkerExecutionMetric[] = [], seenRuns = new Set<string>();
    for (const workstream of board?.revision.workstreams ?? []) {
      const ctoId = workstream.spec.assignedCtoId, workstreamId = workstream.spec.id;
      if (!ctos.ctos.some(cto => cto.ctoId === ctoId && cto.status !== "RETIRED")) throw new Error("Metrics CTO is not current.");
      const workstreamScope = new Set(sharedScope), workstreamPlatform = track(workstreamScope);
      const packets = await createTaskPacketStore(workspaceId, workspaceId, ctoId, workstreamId, workstreamPlatform.state).current();
      const registry = parseTaskWorkerRegistry(await workstreamPlatform.state.get({ scopeKind: "company", scopeId: workspaceId,
        namespace: "sonpark.my-builder", stateKey: taskWorkerRegistryKey(workspaceId, ctoId) }) ?? { schemaVersion: 1,
        workspaceId, projectId: workspaceId, ctoId, revision: 0, records: [] }, workspaceId, workspaceId, ctoId);
      for (const worker of registry.records.filter(item => item.workstreamId === workstreamId)) {
        if (worker.source.specRevision !== workstream.spec.revision
          || worker.source.instructionSha256 !== workstreamInstructionDigest(workstream)) continue;
        const packet = packets?.revision.packets.find(item => item.packet.taskId === worker.taskId);
        if (!packet) continue;
        let binding;
        try { binding = deriveTaskWorkerFileBinding({ workspaceId, projectId: workspaceId, ctoId, packet,
          currentPackets: packets!.revision.packets, worker }); }
        catch { continue; }
        if (runs.length >= MAX_RUNS) return { status: "unknown", reason: "metrics-run-inventory-over-bound" };
        const rowScope = new Set(workstreamScope), rowPlatform = track(rowScope);
        const assertCurrent = () => check(rowScope);
        const commitAcceptanceMs = worker.role === "worker" ? await currentCommitAcceptanceMs({ workspaceId,
          projectId: workspaceId, ctoId, workstreamId, packet, worker, packets: packets!.revision.packets,
          platform: rowPlatform, assertCurrent }) : null;
        const observation = await readTaskWorkerSessionRun({ platform: rowPlatform, binding, assertCurrent });
        const base = { ctoId, workstreamId, taskId: worker.taskId, role: worker.role, packetRevision: worker.packetRevision,
          requestId: observation.requestId, runId: observation.runId, commitAcceptanceMs };
        if (observation.status !== "observed") {
          runs.push({ ...base, runStatus: observation.status, normalEnded: false, timing: null, queueMs: null, executionMs: null, reason: observation.reason });
          const continuation = await currentQaContinuationMetric({ workspaceId, ctoId, workstreamId, packet,
            packets: packets!.revision.packets, worker, requestId: observation.requestId, originalRunId: observation.runId,
            platform, seenRuns });
          if (continuation) {
            if (runs.length >= MAX_RUNS) return { status: "unknown", reason: "metrics-run-inventory-over-bound" };
            runs.push(continuation);
          }
          continue;
        }
        if (seenRuns.has(observation.runId)) throw new Error("One Run is bound to multiple Worker records.");
        seenRuns.add(observation.runId);
        const current = await rowPlatform.agents.sessions.getRun(worker.sessionId, workspaceId, observation.runId);
        if (current.runId !== observation.runId || current.status !== observation.runStatus) throw new Error("Run changed during metrics read.");
        const timingObservedAt = new Date().toISOString();
        const timingField = Object.getOwnPropertyDescriptor(current, "timing");
        const parsed = timingField?.enumerable && Object.hasOwn(timingField, "value")
          ? readExecutionTiming(timingField.value, current.status, timingObservedAt) : null;
        runs.push({ ...base, runStatus: current.status, normalEnded: current.status === "succeeded" && current.cancellationRequested === false
          && current.termination === "not_applicable", timing: parsed?.timing ?? null, queueMs: parsed?.queueMs ?? null,
          executionMs: parsed?.executionMs ?? null, reason: parsed ? null : "host-run-timing-unavailable-or-inconsistent" });
        const continuation = await currentQaContinuationMetric({ workspaceId, ctoId, workstreamId, packet,
          packets: packets!.revision.packets, worker, requestId: observation.requestId, originalRunId: observation.runId,
          platform, seenRuns });
        if (continuation) {
          if (runs.length >= MAX_RUNS) return { status: "unknown", reason: "metrics-run-inventory-over-bound" };
          runs.push(continuation);
        }
      }
    }
    const observedAt = new Date().toISOString();
    // Recheck every observed mutable record once before returning the full projection.
    await check();
    const executions = runs.filter(run => run.executionMs !== null), queues = runs.filter(run => run.queueMs !== null);
    const acceptedCommits = runs.filter(run => run.commitAcceptanceMs !== null);
    const totalExecutionMs = executions.length ? executions.reduce((sum, run) => sum + run.executionMs!, 0) : null;
    const totalQueueMs = queues.length ? queues.reduce((sum, run) => sum + run.queueMs!, 0) : null;
    const totalCommitAcceptanceMs = acceptedCommits.length
      ? acceptedCommits.reduce((sum, run) => sum + run.commitAcceptanceMs!, 0) : null;
    if ([totalExecutionMs, totalQueueMs, totalCommitAcceptanceMs].some(time => time !== null && !Number.isSafeInteger(time))) {
      return { status: "unknown", reason: "metrics-duration-over-bound" };
    }
    return { status: "ready", workspaceId, projectId: workspaceId, observedAt,
      consistency: "rechecked-current-records-not-a-global-transaction", runs,
      summary: { observedRuns: runs.filter(run => run.runId !== null && !["unknown", "unsupported", "pending"].includes(run.runStatus)).length,
        normalEndedRuns: runs.filter(run => run.normalEnded).length, measuredRuns: executions.length,
        totalExecutionMs, totalQueueMs, commitAcceptanceCount: acceptedCommits.length, totalCommitAcceptanceMs },
      unmeasured: { taskCompletionMs: null, permissionWaitMs: null, integrationWaitMs: null, reworkCount: null, manualInterventionCount: null },
      completionAuthority: "not-established" };
  } catch { return { status: "unknown", reason: "metrics-current-scope-or-run-observation-unavailable" }; }
}
