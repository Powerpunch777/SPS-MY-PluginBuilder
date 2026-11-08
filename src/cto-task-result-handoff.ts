import { createHash, randomUUID } from "node:crypto";
import type { SpsPlatformInvocationContext, SpsStateKey } from "@sonparkserver/plugin-sdk/platform";
import { readProjectCtos } from "./project-cto-tools.ts";
import { readWorkstreams } from "./workstream-tools.ts";
import { createCtoDeliveryStore, workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey } from "./domain/task-workers.ts";
import { taskPacketRecordDigest } from "./domain/task-packets.ts";
import { createTaskPacketStore } from "./task-packet-tools.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "./task-worker-runtime.ts";
import { readTaskSourceClaim } from "./task-source-submissions.ts";
import { createTaskQaReportStore } from "./task-qa-reports.ts";
import { readWorkspaceSourceGitTipProof } from "./workspace-source-git-tip.ts";
import { createTaskQaRunReferenceStore } from "./task-qa-run-references.ts";
import { parseProtectedRun } from "./task-protected-qa.ts";
import { readAcceptedTaskSourceForQa } from "./task-source-acceptance.ts";
import type { CtoDelivery, CtoTaskResultHandoff } from "./domain/cto-deliveries.ts";
import type { RevisionState, RevisionPublicationGuard } from "./solution-revision-store.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const stateKey = (workspaceId: string, key: string) => ({ scopeKind: "company" as const, scopeId: workspaceId,
  namespace: "sonpark.my-builder", stateKey: key });
type Terminal = Readonly<{ runId: string; sessionId: string; requestId: string; status: "succeeded" | "failed" | "cancelled";
  resultSha256: string; finishedAt: string }>;
type DispatchApi = (sessionId: string, companyId: string, input: Readonly<{ previousRunId: string; eventId: string;
  sourceSessionId: string; sourceRunId: string; guards: readonly Readonly<{ stateKey: string; namespace?: string; expectedValue: unknown }>[] }>) => Promise<unknown>;
type Platform = SpsPlatformInvocationContext & Readonly<{ agents: SpsPlatformInvocationContext["agents"] & { sessions:
  SpsPlatformInvocationContext["agents"]["sessions"] & { dispatchSessionTerminalEventV1?: DispatchApi } } }>;

function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("Expected a plain record.");
  }
  const keys = Reflect.ownKeys(value), allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => typeof key !== "string" || !allowed.has(key))) throw new TypeError("Record has unknown or missing fields.");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("Record fields must be own data properties.");
    result[key] = descriptor.value;
  }
  return result;
}

function terminal(value: unknown): Terminal {
  const event = exact(value, ["schemaVersion", "runId", "sessionId", "requestId", "status", "resultSha256", "finishedAt"]);
  if (event.schemaVersion !== 1 || typeof event.runId !== "string" || !UUID.test(event.runId)
    || typeof event.sessionId !== "string" || !UUID.test(event.sessionId) || typeof event.requestId !== "string" || !UUID.test(event.requestId)
    || !TERMINAL.has(String(event.status)) || typeof event.resultSha256 !== "string" || !SHA.test(event.resultSha256)
    || typeof event.finishedAt !== "string" || !Number.isFinite(Date.parse(event.finishedAt)) || new Date(event.finishedAt).toISOString() !== event.finishedAt) {
    throw new TypeError("A canonical actual Core terminal observation is required.");
  }
  return Object.freeze({ runId: event.runId, sessionId: event.sessionId, requestId: event.requestId,
    status: event.status as Terminal["status"], resultSha256: event.resultSha256, finishedAt: event.finishedAt });
}

function captureState(platform: Platform, workspaceId: string) {
  const captured = new Map<string, RevisionPublicationGuard>();
  const base = platform.state as typeof platform.state & RevisionState;
  const state: RevisionState = { get: async (key: SpsStateKey) => {
    if (key.scopeKind !== "company" || key.scopeId !== workspaceId) throw new Error("Handoff state read escaped its Workspace.");
    const value = await base.get(key);
    if (value === null) return value;
    const namespace = key.namespace ?? "default", identity = `${namespace}\0${key.stateKey}`;
    const encoded = JSON.stringify(value);
    const prior = captured.get(identity);
    if (prior && JSON.stringify(prior.expectedValue) !== encoded) throw new Error("Handoff authority changed during observation.");
    captured.set(identity, { stateKey: key.stateKey, ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: value });
    return value;
  }, compareAndSet: base.compareAndSet ? async (key, expected, value) => {
    const result = await base.compareAndSet!(key, expected, value);
    if (result.swapped && key.scopeKind === "company" && key.scopeId === workspaceId) {
      const identity = `${key.namespace ?? "default"}\0${key.stateKey}`;
      if (captured.has(identity)) captured.set(identity, { stateKey: key.stateKey,
        ...(key.namespace === undefined ? {} : { namespace: key.namespace }), expectedValue: value });
    }
    return result;
  } : undefined };
  return { state, guards(accept: (stateKey: string) => boolean = () => true) {
    const guards = [...captured.values()].filter(guard => !guard.stateKey.includes("-revision.v1.") && accept(guard.stateKey));
    if (guards.length < 1 || guards.length > 64 || Buffer.byteLength(JSON.stringify(guards), "utf8") > 200_000) {
      throw new Error("Exact handoff guard inventory is unavailable or over bound.");
    }
    return guards;
  } };
}

function scopedGuardKeyset(workspaceId: string, ctoId: string, workstreamId: string, taskId: string, role: "worker" | "qa", sourceSubmissionId: string | null) {
  const rawHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const jsonHash = (value: unknown) => rawHash(JSON.stringify(value));
  const head = (prefix: string, projectId: string) => `${prefix}-head.v1.${rawHash(projectId)}`;
  const packetJournalProject = `packets:${jsonHash([workspaceId, ctoId, workstreamId])}`;
  const deliveryJournalProject = `cto:${jsonHash([workspaceId, ctoId])}`;
  const allowed = new Set([head("workstreams", workspaceId), `project-ctos.v1.${rawHash(workspaceId)}`,
    head("task-packets", packetJournalProject), head("cto-delivery", deliveryJournalProject), taskWorkerRegistryKey(workspaceId, ctoId)]);
  if (role === "qa") {
    const scope = { workspaceId, projectId: workspaceId, ctoId, workstreamId, qaTaskId: taskId };
    allowed.add(head("task-qa-reports", jsonHash(scope)));
    allowed.add(head("task-protected-qa-runs", jsonHash(scope)));
  }
  if (sourceSubmissionId) {
    allowed.add(`task-source-intent.v1.${sourceSubmissionId}`);
    allowed.add(`task-source-outcome.v1.${sourceSubmissionId}`);
    allowed.add(`task-source-intent.v2.${sourceSubmissionId}`);
    allowed.add(`task-source-outcome.v2.${sourceSubmissionId}`);
    allowed.add(`task-source-acceptance.v1.${sourceSubmissionId}`);
  }
  return (key: string) => allowed.has(key) || key.startsWith("task-source-intent.v1.")
    || key.startsWith("task-source-outcome.v1.") || key.startsWith("task-source-intent.v2.")
    || key.startsWith("task-source-outcome.v2.") || key.startsWith("task-source-acceptance.v1.");
}

function assertScopedGuardCoverage(guards: readonly RevisionPublicationGuard[], workspaceId: string, ctoId: string,
  workstreamId: string, taskId: string, role: "worker" | "qa", sourceSubmissionId: string | null) {
  const keys = new Set(guards.map(guard => guard.stateKey));
  const rawHash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const jsonHash = (value: unknown) => rawHash(JSON.stringify(value));
  const heads = [
    `workstreams-head.v1.${rawHash(workspaceId)}`,
    `project-ctos.v1.${rawHash(workspaceId)}`,
    `task-packets-head.v1.${rawHash(`packets:${jsonHash([workspaceId, ctoId, workstreamId])}`)}`,
    `cto-delivery-head.v1.${rawHash(`cto:${jsonHash([workspaceId, ctoId])}`)}`,
    taskWorkerRegistryKey(workspaceId, ctoId),
  ];
  if (role === "qa") {
    const scope = { workspaceId, projectId: workspaceId, ctoId, workstreamId, qaTaskId: taskId };
    heads.push(`task-qa-reports-head.v1.${rawHash(jsonHash(scope))}`,
      `task-protected-qa-runs-head.v1.${rawHash(jsonHash(scope))}`);
  }
  const missing = heads.filter(key => !keys.has(key));
  if (missing.length) throw new Error("Required current Task-result source guards are missing.");
  if (sourceSubmissionId !== null && !guards.some(guard => guard.stateKey.startsWith("task-source-outcome.v2."))) {
    throw new Error("Exact Task source claim outcome guard is missing.");
  }
  if (role === "qa" && sourceSubmissionId
    && !keys.has(`task-source-acceptance.v1.${sourceSubmissionId}`)) {
    throw new Error("Exact CTO source acceptance guard is missing.");
  }
}

function parseReceipt(value: unknown, requestId: string, runId: string) {
  const receipt = exact(value, ["requestId", "state", "runId"]);
  if (receipt.requestId !== requestId || receipt.state !== "submitted" || receipt.runId !== runId) throw new Error("Submitted Core request does not bind the exact terminal Run.");
}

function parseRun(value: unknown, runId: string, expectedStatus: string) {
  const run = exact(value, ["runId", "status", "cancellationRequested", "termination"], ["errorCode", "error", "execution", "output", "timing", "systemEvent"]);
  if (run.runId !== runId || run.status !== expectedStatus || typeof run.cancellationRequested !== "boolean") throw new Error("Core Run differs from its terminal event.");
  return run;
}

async function taskResult(input: Readonly<{ workspaceId: string; workstreamId: string; ctoId: string; taskId: string; role: "worker" | "qa";
  packet: import("./domain/task-packets.ts").TaskPacketRecord; packets: readonly import("./domain/task-packets.ts").TaskPacketRecord[];
  worker: import("./domain/task-workers.ts").TaskWorkerRecord; platform: Platform; terminal: Terminal }>) {
  const { workspaceId, workstreamId, ctoId, taskId, role, packet, packets, worker, platform, terminal: event } = input;
  const binding = deriveTaskWorkerFileBinding({ workspaceId, projectId: workspaceId, ctoId, packet, currentPackets: packets, worker });
  let requestId: string;
  let run: Record<string, unknown>;
  if (role === "worker") {
    requestId = taskWorkerRequestId(binding);
    if (requestId !== event.requestId) throw new Error("Worker terminal request does not match its current Task registration.");
    parseReceipt(await platform.agents.sessions.getRequest(worker.sessionId, workspaceId, requestId), requestId, event.runId);
    run = parseRun(await platform.agents.sessions.getRun(worker.sessionId, workspaceId, event.runId), event.runId, event.status);
    const terminalStateMatches = event.status === "cancelled"
      ? run.cancellationRequested === true && run.termination === "confirmed"
      : run.cancellationRequested === false && run.termination === "not_applicable";
    if (!terminalStateMatches) throw new Error("Worker terminal status and Core cancellation termination facts disagree.");
    if (event.status === "failed") {
      // Relay the Core failure fact, not a claim about whether partial file or Git effects occurred.
      return { binding, requestId, run, sourceCommitSha: null, sourceSubmissionId: null, qaReportRevisionId: null };
    }
  } else {
    const scope = { workspaceId, projectId: workspaceId, ctoId, workstreamId, qaTaskId: taskId };
    const reportStore = createTaskQaReportStore(scope, platform.state as RevisionState);
    const report = (await reportStore.current())?.revision;
    const references = createTaskQaRunReferenceStore(scope, platform.state as RevisionState);
    const reference = (await references.current())?.revision;
    if (!report || !reference || report.author.runId !== event.runId || report.author.sessionId !== worker.sessionId || report.author.agentId !== worker.agentId
      || report.reference.revisionId !== reference.revisionId || reference.binding.qaSessionId !== worker.sessionId
      || reference.binding.qaAgentId !== worker.agentId || reference.binding.qaRevision !== binding.packetRevision
      || reference.binding.qaDigest !== binding.packetRecordSha256 || reference.binding.sourceId !== binding.sourceAccess.sourceId
      || reference.binding.folderKey !== binding.sourceAccess.folderKey || reference.binding.branch !== binding.sourceAccess.branch) {
      throw new Error("Exact current QA Run has no matching published report.");
    }
    const protectedApi = (platform as Platform & { protectedTests?: { getRunV1?: (companyId: string, runId: string, subjectHash: string) => Promise<unknown> } }).protectedTests;
    if (typeof protectedApi?.getRunV1 !== "function") throw new Error("Protected Core run reader is unavailable.");
    const protectedRun = parseProtectedRun(await protectedApi.getRunV1(workspaceId, reference.binding.runId, reference.binding.subjectKeySha256));
    if (protectedRun.id !== reference.binding.runId || protectedRun.pins.approvalId !== reference.binding.approvalId
      || protectedRun.pins.sourceId !== reference.binding.sourceId || protectedRun.pins.commitSha !== reference.binding.commitSha
      || protectedRun.pins.treeSha !== reference.binding.treeSha || protectedRun.pins.subjectKeySha256 !== reference.binding.subjectKeySha256
      || protectedRun.pins.planSha256 !== reference.binding.planSha256
      || !["succeeded", "failed", "cancelled"].includes(protectedRun.status)
      || protectedRun.status !== report.coreStatus
      || protectedRun.termination !== "confirmed"
      || !protectedRun.receipt || typeof protectedRun.receipt !== "object"
      || Object.getOwnPropertyDescriptor(protectedRun.receipt, "digest")?.value !== report.coreReceiptDigest) {
      throw new Error("QA report does not match the exact current protected Core receipt.");
    }
    const originalRequestId = taskWorkerRequestId(binding);
    const originalReceipt = exact(await platform.agents.sessions.getRequest(worker.sessionId, workspaceId, originalRequestId), ["requestId", "state", "runId"]);
    if (originalReceipt.requestId !== originalRequestId || originalReceipt.state !== "submitted" || typeof originalReceipt.runId !== "string"
      || !UUID.test(originalReceipt.runId)) throw new Error("Original QA Worker request is unavailable.");
    const originalRun = exact(await platform.agents.sessions.getRun(worker.sessionId, workspaceId, originalReceipt.runId),
      ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"], ["execution", "output", "timing", "systemEvent"]);
    if (originalRun.runId !== originalReceipt.runId || !["succeeded", "failed", "interrupted", "timed_out"].includes(String(originalRun.status))
      || originalRun.cancellationRequested !== false || originalRun.termination !== "not_applicable") {
      throw new Error("Original QA Worker Run is not a confirmed uncancelled yield.");
    }
    requestId = event.requestId;
    if (event.runId === originalReceipt.runId) {
      if (requestId !== originalRequestId) throw new Error("Original QA Run request identity changed.");
    } else {
      const lineageRun = exact(await platform.agents.sessions.getRun(worker.sessionId, workspaceId, event.runId),
        ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"], ["execution", "output", "timing", "systemEvent"]);
      const systemEvent = exact(lineageRun.systemEvent, ["schemaVersion", "kind", "requestId", "previousRunId", "eventId",
        "protectedRunId", "receiptDigest", "subjectKeySha256"]);
      if (lineageRun.runId !== event.runId || systemEvent.schemaVersion !== 1 || systemEvent.kind !== "protected-test-terminal-event"
        || systemEvent.requestId !== requestId || systemEvent.previousRunId !== originalReceipt.runId
        || systemEvent.protectedRunId !== reference.binding.runId || systemEvent.receiptDigest !== report.coreReceiptDigest
        || systemEvent.subjectKeySha256 !== reference.binding.subjectKeySha256) {
        throw new Error("QA author continuation lacks exact Core protected-run lineage.");
      }
      const continuationRequest = exact(await platform.agents.sessions.getRequest(worker.sessionId, workspaceId, requestId), ["requestId", "state", "runId"]);
      if (continuationRequest.requestId !== requestId || continuationRequest.state !== "submitted" || continuationRequest.runId !== event.runId) {
        throw new Error("QA author continuation request does not match its actual Core Run.");
      }
    }
    const sessions = await (platform.agents.sessions as unknown as { list(agentId: string, companyId: string): Promise<unknown> }).list(worker.agentId, workspaceId);
    if (!Array.isArray(sessions) || sessions.length > 100) throw new Error("Current QA session registry is unavailable.");
    const matchingSessions = sessions.filter(row => row && typeof row === "object" && !Array.isArray(row)
      && Object.getOwnPropertyDescriptor(row, "sessionId")?.value === worker.sessionId);
    if (matchingSessions.length !== 1 || Object.getOwnPropertyDescriptor(matchingSessions[0], "agentId")?.value !== worker.agentId
      || Object.getOwnPropertyDescriptor(matchingSessions[0], "companyId")?.value !== workspaceId
      || Object.getOwnPropertyDescriptor(matchingSessions[0], "taskKey")?.value !== `plugin:com.sonparkserver.my-plugin-builder:session:${worker.pluginAgentKey}`
      || Object.getOwnPropertyDescriptor(matchingSessions[0], "status")?.value !== "active"
      || Object.getOwnPropertyDescriptor(matchingSessions[0], "closedAt")?.value !== null
      || Object.getOwnPropertyDescriptor(matchingSessions[0], "lastRunId")?.value !== event.runId) {
      throw new Error("QA author Run is not the current registered QA session head.");
    }
    const implementation = packets.find(row => row.packet.taskId === reference.binding.implementationTaskId);
    if (!implementation || !packet.dependencyPins.some(pin => pin.taskId === implementation.packet.taskId
      && pin.revision === reference.binding.implementationRevision && pin.recordSha256 === reference.binding.implementationDigest)) {
      throw new Error("Current QA Task no longer depends on the exact implementation packet.");
    }
    const rawWorkers = await platform.state.get(stateKey(workspaceId, taskWorkerRegistryKey(workspaceId, ctoId)));
    if (rawWorkers === null) throw new Error("Current QA Worker registry is unavailable.");
    const workerRegistry = parseTaskWorkerRegistry(rawWorkers, workspaceId, workspaceId, ctoId);
    const accepted = await readAcceptedTaskSourceForQa({ workspaceId, projectId: workspaceId, ctoId, workstreamId, task: implementation,
      packets, workerRecords: workerRegistry.records, state: platform.state as RevisionState, platform, assertCurrent: async () => {
        const latestReference = (await references.current())?.revision;
        const latestReport = (await reportStore.current())?.revision;
        if (latestReference?.revisionId !== reference.revisionId || latestReport?.revisionId !== report.revisionId) {
          throw new Error("QA reference or author report changed during source validation.");
        }
      } });
    if (accepted.status !== "accepted" || accepted.submission.submissionId !== reference.binding.submissionId
      || accepted.submission.commitSha !== reference.binding.commitSha || accepted.submission.treeSha !== reference.binding.treeSha
      || accepted.acceptance.acceptanceId !== reference.binding.acceptanceId) throw new Error("QA report source is not the current accepted implementation submission.");
    const readTip = (platform as Platform & { localFolders?: { readWorkspaceSourceGitTipV1?:
      (sourceId: string, folderKey: string, branch: string) => Promise<unknown> } }).localFolders?.readWorkspaceSourceGitTipV1;
    if (typeof readTip !== "function") throw new Error("Current QA Source Git tip reader is unavailable.");
    const tip = readWorkspaceSourceGitTipProof(await readTip(reference.binding.sourceId, reference.binding.folderKey, reference.binding.branch));
    if (tip.status !== "current" || tip.sourceId !== reference.binding.sourceId || tip.folderKey !== reference.binding.folderKey
      || tip.branch !== reference.binding.branch || tip.commitSha !== reference.binding.commitSha || tip.treeSha !== reference.binding.treeSha) {
      throw new Error("QA report Source branch no longer names the exact accepted Commit and Tree.");
    }
    parseReceipt(await platform.agents.sessions.getRequest(worker.sessionId, workspaceId, requestId), requestId, event.runId);
    run = parseRun(await platform.agents.sessions.getRun(worker.sessionId, workspaceId, event.runId), event.runId, event.status);
    const terminalStateMatches = event.status === "cancelled"
      ? run.cancellationRequested === true && run.termination === "confirmed"
      : run.cancellationRequested === false && run.termination === "not_applicable";
    if (!terminalStateMatches) throw new Error("QA author Run terminal facts are inconsistent.");
    return { binding, requestId, run, sourceCommitSha: reference.binding.commitSha, sourceSubmissionId: reference.binding.submissionId,
      qaReportRevisionId: report.revisionId };
  }
  if (role === "worker") {
    const sourceAccess = packet.packet.sourceAccess;
    if (!sourceAccess?.branch || !sourceAccess.expectedHead) throw new Error("Current Worker packet has no exact branch and expected-head source pin.");
    const claim = await readTaskSourceClaim({ state: platform.state as RevisionState, binding: {
      schemaVersion: 1, workspaceId, projectId: workspaceId, ctoId, workstreamId, taskId,
      packetRevision: binding.packetRevision, packetRecordSha256: binding.packetRecordSha256,
      dependencyPins: packet.dependencyPins.map(pin => ({ taskId: pin.taskId, revision: pin.revision, recordSha256: pin.recordSha256 })),
      role: "worker", agentId: worker.agentId, sessionId: worker.sessionId,
      source: { sourceId: sourceAccess.sourceId, folderKey: sourceAccess.folderKey, branch: sourceAccess.branch, expectedHead: sourceAccess.expectedHead },
      readPaths: sourceAccess.readPaths, writePaths: sourceAccess.writePaths, qaWritePaths: sourceAccess.qaWritePaths,
    } });
    if (claim.status !== "submitted" || claim.submission.producer.runId !== event.runId
      || claim.submission.coreStatus !== "committed" || claim.submission.authorityAfterCommit !== "current") {
      throw new Error("Exact current Worker Run has no definitive source submission.");
    }
    const readTip = (platform as Platform & { localFolders?: { readWorkspaceSourceGitTipV1?:
      (sourceId: string, folderKey: string, branch: string) => Promise<unknown> } }).localFolders?.readWorkspaceSourceGitTipV1;
    if (typeof readTip !== "function") throw new Error("Current source Git tip reader is unavailable.");
    const tip = readWorkspaceSourceGitTipProof(await readTip(sourceAccess.sourceId, sourceAccess.folderKey, sourceAccess.branch));
    if (tip.status !== "current" || tip.sourceId !== sourceAccess.sourceId || tip.folderKey !== sourceAccess.folderKey
      || tip.branch !== sourceAccess.branch || tip.commitSha !== claim.submission.commitSha || tip.treeSha !== claim.submission.treeSha) {
      throw new Error("Task source branch no longer names the exact submitted Commit and Tree.");
    }
    return { binding, requestId, run, sourceCommitSha: claim.submission.commitSha,
      sourceSubmissionId: claim.submission.submissionId, qaReportRevisionId: null };
  }
  throw new Error("Unsupported Task result role.");
}

function parseDispatchReceipt(value: unknown) {
  const receipt = exact(value, ["requestId", "runId", "replayed"]);
  if (typeof receipt.requestId !== "string" || !UUID.test(receipt.requestId) || typeof receipt.runId !== "string" || !UUID.test(receipt.runId)
    || typeof receipt.replayed !== "boolean") throw new TypeError("Core terminal dispatch receipt is malformed.");
  return receipt as { requestId: string; runId: string; replayed: boolean };
}

async function observeDispatchedChild(cto: import("./domain/project-ctos.ts").ProjectCto, workspaceId: string,
  previousRunId: string, handoff: CtoTaskResultHandoff, platform: Platform): Promise<ReturnType<typeof parseDispatchReceipt> | null> {
  const sessionApi = platform.agents.sessions as unknown as { list(agentId: string, companyId: string): Promise<unknown> };
  const rows = await sessionApi.list(cto.agentId, workspaceId);
  if (!Array.isArray(rows) || rows.length > 100) return null;
  const matching = rows.filter(row => row && typeof row === "object" && !Array.isArray(row)
    && Object.getOwnPropertyDescriptor(row, "sessionId")?.value === cto.sessionId);
  if (matching.length !== 1 || Object.getOwnPropertyDescriptor(matching[0], "agentId")?.value !== cto.agentId
    || Object.getOwnPropertyDescriptor(matching[0], "companyId")?.value !== workspaceId
    || Object.getOwnPropertyDescriptor(matching[0], "status")?.value !== "active"
    || Object.getOwnPropertyDescriptor(matching[0], "closedAt")?.value !== null) return null;
  const runId = Object.getOwnPropertyDescriptor(matching[0], "lastRunId")?.value;
  if (typeof runId !== "string" || !UUID.test(runId) || runId === previousRunId) return null;
  const rawRun = await platform.agents.sessions.getRun(cto.sessionId!, workspaceId, runId);
  const run = exact(rawRun, ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"],
    ["execution", "output", "timing", "systemEvent"]);
  const lineage = exact(run.systemEvent, ["schemaVersion", "kind", "requestId", "previousRunId", "eventId", "sourceSessionId", "sourceRunId", "resultSha256"]);
  if (run.runId !== runId || !["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(String(run.status))
    || lineage.schemaVersion !== 1 || lineage.kind !== "agent-session-terminal-event" || lineage.previousRunId !== previousRunId
    || lineage.eventId !== handoff.eventId || lineage.sourceSessionId !== handoff.sourceSessionId
    || lineage.sourceRunId !== handoff.sourceRunId || lineage.resultSha256 !== handoff.resultSha256
    || typeof lineage.requestId !== "string" || !UUID.test(lineage.requestId)) return null;
  const request = exact(await platform.agents.sessions.getRequest(cto.sessionId!, workspaceId, lineage.requestId), ["requestId", "state", "runId"]);
  if (request.requestId !== lineage.requestId || request.state !== "submitted" || request.runId !== runId) return null;
  return Object.freeze({ requestId: lineage.requestId, runId, replayed: false });
}

async function saveAcceptedHandoff(store: ReturnType<typeof createCtoDeliveryStore>, eventId: string,
  receipt: ReturnType<typeof parseDispatchReceipt>, previousRunId: string) {
  const latest = (await store.current())?.revision;
  const selected = latest?.taskResultHandoffs?.find(item => item.eventId === eventId);
  if (!latest || !selected) return false;
  if (selected.phase === "accepted") return selected.requestId === receipt.requestId && selected.runId === receipt.runId;
  if (selected.phase !== "pending") return false;
  const accepted = Object.freeze({ ...selected, phase: "accepted" as const, requestId: receipt.requestId, runId: receipt.runId, replayed: receipt.replayed });
  const final = { ...latest, revisionId: randomUUID(), taskResultHandoffs: Object.freeze(latest.taskResultHandoffs!.map(item =>
    item.eventId === eventId ? accepted : item.phase === "pending" && item.previousCtoRunId === previousRunId
      ? Object.freeze({ ...item, previousCtoRunId: receipt.runId, previousCtoRequestId: receipt.requestId }) : item)) };
  return (await store.publish({ expectedBaseRevisionId: latest.revisionId, revision: final })).status === "published";
}

async function reconcileParentTerminal(workspaceId: string, event: Terminal, platform: Platform,
  capture: ReturnType<typeof captureState>): Promise<Readonly<{ status: "accepted" | "ignored" | "stale" | "unknown" | "unsupported";
    reason?: string; requestId?: string; runId?: string; replayed?: boolean }> | null> {
  const board = await readWorkstreams(workspaceId, workspaceId, { ...platform, state: capture.state as typeof platform.state });
  if (!board) return null;
  const candidates: Array<{ ctoId: string; cto: import("./domain/project-ctos.ts").ProjectCto;
    delivery: CtoDelivery; handoff: CtoTaskResultHandoff }> = [];
  const ctos = await readProjectCtos(workspaceId, workspaceId, { ...platform, state: capture.state as typeof platform.state });
  for (const workstream of board.revision.workstreams) {
    const ctoId = workstream.spec.assignedCtoId;
    if (!ctoId) continue;
    const current = (await createCtoDeliveryStore(workspaceId, workspaceId, ctoId, capture.state).current())?.revision;
    if (!current || current.instruction.spec.id !== workstream.spec.id
      || workstreamInstructionDigest(current.instruction) !== workstreamInstructionDigest(workstream)) continue;
    const cto = ctos.ctos.find(row => row.ctoId === ctoId && row.sessionId === event.sessionId
      && row.agentId === current.instruction.ctoAgentId && row.status !== "RETIRED");
    if (!cto) continue;
    for (const handoff of current.taskResultHandoffs ?? []) {
      if (handoff.phase === "pending" && handoff.ctoSessionId === event.sessionId && handoff.previousCtoRunId === event.runId) {
        candidates.push({ ctoId, cto, delivery: current, handoff });
      }
    }
  }
  if (!candidates.length) {
    for (const workstream of board.revision.workstreams) {
      const ctoId = workstream.spec.assignedCtoId;
      if (!ctoId) continue;
      const cto = ctos.ctos.find(row => row.ctoId === ctoId && row.sessionId === event.sessionId && row.status !== "RETIRED");
      if (!cto) continue;
      const store = createCtoDeliveryStore(workspaceId, workspaceId, ctoId, capture.state);
      const delivery = (await store.current())?.revision;
      if (!delivery || delivery.instruction.spec.id !== workstream.spec.id
        || workstreamInstructionDigest(delivery.instruction) !== workstreamInstructionDigest(workstream)) continue;
      for (const handoff of delivery.taskResultHandoffs ?? []) {
        if (handoff.phase !== "pending" || handoff.ctoSessionId !== event.sessionId || handoff.previousCtoRunId === event.runId) continue;
        const adopted = await observeDispatchedChild(cto, workspaceId, handoff.previousCtoRunId, handoff, platform);
        if (!adopted || adopted.runId !== event.runId || adopted.requestId !== event.requestId) continue;
        const saved = await saveAcceptedHandoff(store, handoff.eventId, adopted, handoff.previousCtoRunId);
        if (!saved) return { status: "unknown" as const, reason: "early-child-terminal-receipt-adoption-uncertain" };
        const drained: Awaited<ReturnType<typeof reconcileParentTerminal>> = await reconcileParentTerminal(workspaceId, event, platform, capture);
        return drained ?? { status: "accepted" as const, requestId: adopted.requestId, runId: adopted.runId, replayed: adopted.replayed };
      }
    }
    const known = ctos.ctos.filter(row => row.sessionId === event.sessionId && row.status !== "RETIRED");
    if (!known.length) return null;
    for (const _cto of known) {
      const receipt = exact(await platform.agents.sessions.getRequest(event.sessionId, workspaceId, event.requestId), ["requestId", "state", "runId"]);
      if (receipt.requestId !== event.requestId || receipt.state !== "submitted" || receipt.runId !== event.runId) continue;
      const run = parseRun(await platform.agents.sessions.getRun(event.sessionId, workspaceId, event.runId), event.runId, event.status);
      const isActualTerminal = event.status === "cancelled" ? run.cancellationRequested === true && run.termination === "confirmed"
        : run.cancellationRequested === false && run.termination === "not_applicable";
      if (isActualTerminal) return { status: "ignored" as const, reason: "known-cto-terminal-has-no-current-pending-result" };
    }
    return { status: "unknown" as const, reason: "known-cto-terminal-request-or-run-is-not-exact" };
  }
  if (candidates.length > 1) candidates.sort((left, right) => left.handoff.eventId.localeCompare(right.handoff.eventId));
  const selected = candidates[0]!;
  if (selected.handoff.previousCtoRequestId !== event.requestId) {
    return { status: "stale" as const, reason: "parent-terminal-does-not-match-current-delivery-request" };
  }
  const parentRun = parseRun(await platform.agents.sessions.getRun(event.sessionId, workspaceId, event.runId), event.runId, event.status);
  const parentTerminalMatches = event.status === "cancelled"
    ? parentRun.cancellationRequested === true && parentRun.termination === "confirmed"
    : parentRun.cancellationRequested === false && parentRun.termination === "not_applicable";
  if (!parentTerminalMatches) return { status: "stale" as const, reason: "parent-terminal-core-facts-mismatch" };
  if (event.status === "cancelled") return { status: "stale" as const, reason: "cancelled-cto-parent-is-not-wakeable" };
  const store = createCtoDeliveryStore(workspaceId, workspaceId, selected.ctoId, capture.state);
  const list = await (platform.agents.sessions as unknown as { list(agentId: string, companyId: string): Promise<unknown> }).list(selected.cto.agentId, workspaceId);
  if (!Array.isArray(list) || list.length > 100) return { status: "unknown" as const, reason: "cto-session-registry-unavailable" };
  const rows = list.filter(row => row && typeof row === "object" && !Array.isArray(row)
    && Object.getOwnPropertyDescriptor(row, "sessionId")?.value === event.sessionId);
  if (rows.length !== 1 || Object.getOwnPropertyDescriptor(rows[0], "agentId")?.value !== selected.cto.agentId
    || Object.getOwnPropertyDescriptor(rows[0], "companyId")?.value !== workspaceId
    || Object.getOwnPropertyDescriptor(rows[0], "status")?.value !== "active"
    || Object.getOwnPropertyDescriptor(rows[0], "closedAt")?.value !== null) {
    return { status: "stale" as const, reason: "parent-terminal-session-is-not-current" };
  }
  const currentRunId = Object.getOwnPropertyDescriptor(rows[0], "lastRunId")?.value;
  if (currentRunId !== event.runId) {
    const adopted = await observeDispatchedChild(selected.cto, workspaceId, event.runId, selected.handoff, platform);
    if (!adopted) return { status: "stale" as const, reason: "current-run-does-not-match-pending-core-lineage" };
    const saved = await saveAcceptedHandoff(store, selected.handoff.eventId, adopted, event.runId);
    return saved ? { status: "accepted" as const, requestId: adopted.requestId, runId: adopted.runId, replayed: adopted.replayed }
      : { status: "unknown" as const, reason: "adopted-core-receipt-could-not-be-journaled" };
  }
  const packets = (await createTaskPacketStore(workspaceId, workspaceId, selected.ctoId, selected.handoff.workstreamId, capture.state).current())?.revision.packets ?? [];
  const registryRaw = await capture.state.get(stateKey(workspaceId, taskWorkerRegistryKey(workspaceId, selected.ctoId)));
  if (registryRaw === null) return { status: "stale" as const, reason: "current-task-worker-registry-unavailable" };
  const registry = parseTaskWorkerRegistry(registryRaw, workspaceId, workspaceId, selected.ctoId);
  const workers = registry.records.filter(row => row.sessionId === selected.handoff.sourceSessionId
    && row.taskId === selected.handoff.taskId && row.workstreamId === selected.handoff.workstreamId
    && row.role === selected.handoff.role && row.packetRevision === selected.handoff.packetRevision
    && row.packetRecordSha256 === selected.handoff.packetRecordSha256);
  const packet = packets.find(row => row.packet.taskId === selected.handoff.taskId
    && row.packet.revision === selected.handoff.packetRevision
    && taskPacketRecordDigest(row, workspaceId, selected.ctoId, selected.handoff.workstreamId) === selected.handoff.packetRecordSha256);
  if (workers.length !== 1 || !packet) return { status: "stale" as const, reason: "source-task-or-worker-binding-changed" };
  const sourceEvent: Terminal = Object.freeze({ runId: selected.handoff.sourceRunId, sessionId: selected.handoff.sourceSessionId,
    requestId: selected.handoff.sourceRequestId, status: selected.handoff.sourceStatus,
    resultSha256: selected.handoff.resultSha256, finishedAt: selected.handoff.sourceFinishedAt });
  const result = await taskResult({ workspaceId, workstreamId: selected.handoff.workstreamId, ctoId: selected.ctoId,
    taskId: selected.handoff.taskId, role: selected.handoff.role, packet, packets, worker: workers[0]!,
    platform: { ...platform, state: capture.state as typeof platform.state }, terminal: sourceEvent });
  if (result.requestId !== selected.handoff.sourceRequestId || result.sourceCommitSha !== selected.handoff.sourceCommitSha
    || result.qaReportRevisionId !== selected.handoff.qaReportRevisionId) {
    return { status: "stale" as const, reason: "source-result-or-report-changed" };
  }
  if (typeof platform.agents.sessions.dispatchSessionTerminalEventV1 !== "function") {
    return { status: "unsupported" as const, reason: "session-terminal-event-dispatch-unavailable" };
  }
  const guards = capture.guards(scopedGuardKeyset(workspaceId, selected.ctoId, selected.handoff.workstreamId,
    selected.handoff.taskId, selected.handoff.role, selected.handoff.sourceSubmissionId));
  assertScopedGuardCoverage(guards, workspaceId, selected.ctoId, selected.handoff.workstreamId, selected.handoff.taskId,
    selected.handoff.role, selected.handoff.sourceSubmissionId);
  const receipt = parseDispatchReceipt(await platform.agents.sessions.dispatchSessionTerminalEventV1(event.sessionId, workspaceId, {
    previousRunId: event.runId, eventId: selected.handoff.eventId, sourceSessionId: selected.handoff.sourceSessionId,
    sourceRunId: selected.handoff.sourceRunId,
    guards,
  }));
  const latest = (await store.current())?.revision;
  const reserved = latest?.taskResultHandoffs?.find(row => row.eventId === selected.handoff.eventId && row.phase === "pending");
  if (!latest || !reserved) return { status: "unknown" as const, reason: "pending-handoff-changed-after-core-admission" };
  const saved = await saveAcceptedHandoff(store, selected.handoff.eventId, receipt, event.runId);
  if (!saved) return { status: "unknown" as const, reason: "core-admitted-handoff-ledger-update-uncertain" };
  return { status: "accepted" as const, requestId: receipt.requestId, runId: receipt.runId, replayed: receipt.replayed };
}

/** Read-only authority resolution followed by the existing Core event admission; this never declares Task or Workstream completion. */
export async function consumeCtoTaskResultTerminal(workspaceId: string, eventId: string, rawTerminal: unknown, rawPlatform: SpsPlatformInvocationContext) {
  const event = terminal(rawTerminal);
  if (!UUID.test(workspaceId) || !/^agent-session-terminal-v1:[a-f0-9]{64}$/u.test(eventId)) return { status: "unknown" as const, reason: "invalid-terminal-event-identity" };
  const platform = rawPlatform as Platform;
  const capture = captureState(platform, workspaceId);
  try {
    const parentResult = await reconcileParentTerminal(workspaceId, event, platform, capture);
    if (parentResult) return parentResult;
    const board = await readWorkstreams(workspaceId, workspaceId, { ...platform, state: capture.state as typeof platform.state });
    if (!board) return { status: "not-applicable" as const, reason: "no-current-workstream-board" };
    if (board.revision.workstreams.length > 128) return { status: "unknown" as const, reason: "current-workstream-inventory-over-bound" };
    const matches: Array<{ ctoId: string; workstreamId: string; taskId: string; role: "worker" | "qa";
      worker: import("./domain/task-workers.ts").TaskWorkerRecord; packet: import("./domain/task-packets.ts").TaskPacketRecord;
      packets: readonly import("./domain/task-packets.ts").TaskPacketRecord[]; delivery: CtoDelivery; result: Awaited<ReturnType<typeof taskResult>> }> = [];
    let scanned = 0, knownWorker = false;
    for (const workstream of board.revision.workstreams) {
      const ctoId = workstream.spec.assignedCtoId;
      if (!ctoId) continue;
      const records = (await createTaskPacketStore(workspaceId, workspaceId, ctoId, workstream.spec.id,
        capture.state).current())?.revision.packets ?? [];
      const registryRaw = await capture.state.get(stateKey(workspaceId, taskWorkerRegistryKey(workspaceId, ctoId)));
      if (registryRaw === null) continue;
      const registry = parseTaskWorkerRegistry(registryRaw, workspaceId, workspaceId, ctoId);
      for (const worker of registry.records) {
        if (worker.sessionId !== event.sessionId || worker.workstreamId !== workstream.spec.id) continue;
        knownWorker = true;
        if (++scanned > 512) throw new Error("Terminal task-worker scan exceeds its bound.");
        const packet = records.find(item => item.packet.taskId === worker.taskId);
        if (!packet || packet.packet.revision !== worker.packetRevision) continue;
        const binding = deriveTaskWorkerFileBinding({ workspaceId, projectId: workspaceId, ctoId, packet, currentPackets: records, worker });
        if (worker.role === "worker" && taskWorkerRequestId(binding) !== event.requestId) continue;
        if (worker.role === "qa") {
          const report = (await createTaskQaReportStore({ workspaceId, projectId: workspaceId, ctoId,
            workstreamId: workstream.spec.id, qaTaskId: worker.taskId }, capture.state).current())?.revision;
          if (!report || report.author.runId !== event.runId || report.author.sessionId !== event.sessionId
            || report.author.agentId !== worker.agentId) continue;
        }
        const delivery = (await createCtoDeliveryStore(workspaceId, workspaceId, ctoId, capture.state).current())?.revision;
        if (!delivery || delivery.instruction.spec.id !== workstream.spec.id || workstreamInstructionDigest(delivery.instruction) !== workstreamInstructionDigest(workstream)
          || delivery.instruction.ctoSessionId === worker.sessionId || !delivery.runId || delivery.cancellationRequested
          || ["prepared", "dispatching", "uncertain", "superseded", "cancelled"].includes(delivery.phase)) continue;
        const result = await taskResult({ workspaceId, workstreamId: workstream.spec.id, ctoId, taskId: worker.taskId,
          role: worker.role, packet, packets: records, worker, platform: { ...platform, state: capture.state as typeof platform.state }, terminal: event });
        matches.push({ ctoId, workstreamId: workstream.spec.id, taskId: worker.taskId, role: worker.role,
          worker, packet, packets: records, delivery, result });
      }
    }
    if (matches.length !== 1) return { status: matches.length ? "unknown" as const : knownWorker ? "ignored" as const : "not-applicable" as const,
      reason: matches.length ? "terminal-session-matches-multiple-current-workers" : knownWorker ? "known-worker-terminal-has-no-current-result" : "no-current-cto-or-worker-role" };
    const selected = matches[0]!;
    const prior = selected.delivery.taskResultHandoffs?.find(item => item.eventId === eventId);
    if (prior?.phase === "accepted") return { status: "accepted" as const, requestId: prior.requestId, runId: prior.runId, replayed: prior.replayed };
    if (prior?.phase === "uncertain") return { status: "unknown" as const, reason: "prior-terminal-handoff-outcome-uncertain" };
    if (typeof platform.agents.sessions.dispatchSessionTerminalEventV1 !== "function") {
      return { status: "unsupported" as const, reason: "session-terminal-event-dispatch-unavailable" };
    }
    if (typeof platform.agents.sessions.getRequest !== "function" || typeof platform.agents.sessions.getRun !== "function") {
      return { status: "unsupported" as const, reason: "core-session-readers-unavailable" };
    }
    const ctos = await readProjectCtos(workspaceId, workspaceId, { ...platform, state: capture.state as typeof platform.state });
    const cto = ctos.ctos.find(item => item.ctoId === selected.ctoId && item.agentId === selected.delivery!.instruction.ctoAgentId
      && item.sessionId === selected.delivery!.instruction.ctoSessionId && item.status !== "RETIRED");
    if (!cto || selected.delivery!.runId === null) return { status: "stale" as const, reason: "current-cto-binding-unavailable" };
    const latestAccepted = [...(selected.delivery!.taskResultHandoffs ?? [])].reverse().find(item => item.phase === "accepted");
    const sessions = platform.agents.sessions as unknown as { list(agentId: string, companyId: string): Promise<unknown> };
    const sessionRows = await sessions.list(cto.agentId, workspaceId);
    if (!Array.isArray(sessionRows) || sessionRows.length > 100) return { status: "unknown" as const, reason: "cto-current-session-list-unavailable" };
    const ctoRows = sessionRows.filter(row => row && typeof row === "object" && !Array.isArray(row)
      && Object.getOwnPropertyDescriptor(row, "sessionId")?.value === cto.sessionId);
    const headRunId = ctoRows.length === 1 ? Object.getOwnPropertyDescriptor(ctoRows[0], "lastRunId")?.value : undefined;
    const parentRunId = latestAccepted?.runId ?? selected.delivery!.runId;
    const parentRequestId = latestAccepted?.requestId ?? selected.delivery!.requestId;
    if (!parentRunId || !parentRequestId) return { status: "stale" as const, reason: "current-cto-parent-reference-unavailable" };
    if (Object.getOwnPropertyDescriptor(ctoRows[0], "agentId")?.value !== cto.agentId
      || Object.getOwnPropertyDescriptor(ctoRows[0], "companyId")?.value !== workspaceId
      || Object.getOwnPropertyDescriptor(ctoRows[0], "status")?.value !== "active"
      || Object.getOwnPropertyDescriptor(ctoRows[0], "closedAt")?.value !== null) {
      return { status: "stale" as const, reason: "cto-session-head-is-not-the-current-reserved-parent" };
    }
    const handoff: CtoTaskResultHandoff = Object.freeze({ eventId, sourceSessionId: event.sessionId, sourceRunId: event.runId,
      sourceRequestId: event.requestId, workstreamId: selected.workstreamId, taskId: selected.taskId, role: selected.role,
      packetRevision: selected.packet.packet.revision, packetRecordSha256: selected.worker.packetRecordSha256,
      sourceCommitSha: selected.result.sourceCommitSha, sourceSubmissionId: selected.result.sourceSubmissionId,
      qaReportRevisionId: selected.result.qaReportRevisionId,
      sourceStatus: event.status, sourceFinishedAt: event.finishedAt, resultSha256: event.resultSha256,
      ctoSessionId: cto.sessionId!, previousCtoRunId: parentRunId, previousCtoRequestId: parentRequestId,
      phase: "pending", requestId: null, runId: null, replayed: null });
    const store = createCtoDeliveryStore(workspaceId, workspaceId, selected.ctoId, capture.state);
    if (!prior) {
      const updated = { ...selected.delivery!, revisionId: randomUUID(), taskResultHandoffs: Object.freeze([...(selected.delivery!.taskResultHandoffs ?? []), handoff]) };
      const saved = await store.publish({ expectedBaseRevisionId: selected.delivery!.revisionId, revision: updated });
      if (saved.status !== "published") return { status: "stale" as const, reason: "cto-delivery-head-changed" };
    }
    const currentDelivery = (await store.current())?.revision;
    if (!currentDelivery || !currentDelivery.taskResultHandoffs?.some(item => item.eventId === eventId && item.phase === "pending")) {
      return { status: "stale" as const, reason: "pending-handoff-not-current" };
    }
    const pendingHandoff = currentDelivery.taskResultHandoffs.find(item => item.eventId === eventId)!;
    if (headRunId !== parentRunId) {
      const adopted = await observeDispatchedChild(cto, workspaceId, parentRunId, pendingHandoff, platform);
      if (!adopted) return { status: "stale" as const, reason: "current-run-does-not-match-pending-core-lineage" };
      const saved = await saveAcceptedHandoff(store, eventId, adopted, parentRunId);
      return saved ? { status: "accepted" as const, requestId: adopted.requestId, runId: adopted.runId, replayed: adopted.replayed }
        : { status: "unknown" as const, reason: "adopted-core-receipt-could-not-be-journaled" };
    }
    const freshResult = await taskResult({ workspaceId, workstreamId: selected.workstreamId, ctoId: selected.ctoId,
      taskId: selected.taskId, role: selected.role, packet: selected.packet, packets: selected.packets, worker: selected.worker,
      platform: { ...platform, state: capture.state as typeof platform.state }, terminal: event });
    if (freshResult.sourceCommitSha !== selected.result.sourceCommitSha
      || freshResult.qaReportRevisionId !== selected.result.qaReportRevisionId || freshResult.requestId !== selected.result.requestId) {
      return { status: "stale" as const, reason: "source-result-changed-before-core-admission" };
    }
    const ctoReceipt = exact(await platform.agents.sessions.getRequest(cto.sessionId!, workspaceId, parentRequestId), ["requestId", "state", "runId"]);
    if (ctoReceipt.requestId !== parentRequestId || ctoReceipt.state !== "submitted" || ctoReceipt.runId !== parentRunId) {
      return { status: "stale" as const, reason: "current-cto-request-changed" };
    }
    const parentRaw = await platform.agents.sessions.getRun(cto.sessionId!, workspaceId, parentRunId);
    const parentStatus = parentRaw && typeof parentRaw === "object" && !Array.isArray(parentRaw)
      ? Object.getOwnPropertyDescriptor(parentRaw, "status")?.value : undefined;
    if (typeof parentStatus !== "string") return { status: "unknown" as const, reason: "cto-parent-run-status-unavailable" };
    const parentRun = parseRun(parentRaw, parentRunId, parentStatus);
    const parentStillActive = ["queued", "running", "cancelling"].includes(String(parentRun.status))
      || parentRun.cancellationRequested !== false || parentRun.termination === "pending";
    if (parentStillActive) return { status: "waiting" as const, reason: "cto-parent-must-reach-terminal-before-handoff" };
    if (!TERMINAL.has(String(parentRun.status)) || parentRun.cancellationRequested !== false || parentRun.termination !== "not_applicable") {
      return { status: "stale" as const, reason: "cto-parent-is-cancelled-or-not-terminal" };
    }
    const guards = capture.guards(scopedGuardKeyset(workspaceId, selected.ctoId, selected.workstreamId,
      selected.taskId, selected.role, selected.result.sourceSubmissionId));
    assertScopedGuardCoverage(guards, workspaceId, selected.ctoId, selected.workstreamId, selected.taskId,
      selected.role, selected.result.sourceSubmissionId);
    let receipt: ReturnType<typeof parseDispatchReceipt>;
    try {
      receipt = parseDispatchReceipt(await platform.agents.sessions.dispatchSessionTerminalEventV1(cto.sessionId!, workspaceId, {
        previousRunId: parentRunId, eventId, sourceSessionId: event.sessionId, sourceRunId: event.runId, guards,
      }));
    } catch {
      return { status: "unknown" as const, reason: "terminal-handoff-outcome-uncertain" };
    }
    const saved = await saveAcceptedHandoff(store, eventId, receipt, parentRunId);
    if (!saved) return { status: "unknown" as const, reason: "handoff-accepted-but-journal-cas-uncertain" };
    return { status: "accepted" as const, requestId: receipt.requestId, runId: receipt.runId, replayed: receipt.replayed };
  } catch {
    return { status: "unknown" as const, reason: "handoff-observation-or-admission-failed" };
  }
}
