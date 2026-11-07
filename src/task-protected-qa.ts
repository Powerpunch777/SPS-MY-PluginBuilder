import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey, type TaskWorkerRecord } from "./domain/task-workers.ts";
import { taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { exactToolRecord, parseLeadToolContext } from "./lead-tool-authority.ts";
import { resolveCtoTaskAuthority } from "./task-packet-tools.ts";
import { readAcceptedTaskSourceForQa, readCtoTaskSourceSubmission } from "./task-source-acceptance.ts";
import { resolveCurrentTaskWorkerToolCall } from "./task-worker-tools.ts";
import { createTaskQaRunReferenceStore, recordTaskQaRunReference, type TaskQaRunReference } from "./task-qa-run-references.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId } from "./task-worker-runtime.ts";
import { taskQaCriteria } from "./task-qa-criteria.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const subjectDigest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const json = (value: unknown) => value as JsonValue;

type ProtectedRun = Readonly<{ schemaVersion: 1; kind: "protected-node-test-v1"; id: string;
  status: "queued" | "claimed" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  termination: "not_applicable" | "pending" | "confirmed";
  pins: Readonly<{ approvalId: string; sourceId: string; planSha256: string; commitSha: string; treeSha: string; subjectKeySha256: string }>;
  receipt: unknown; timestamps: unknown; qaVerdict: "not-established" }>;
type ProtectedTaskQaResult = Readonly<Record<string, unknown> & { status: string; qaVerdict: "not-established" }>;

type ProtectedTestsApi = Readonly<{
  enqueueApprovedV1?: (input: Readonly<{ companyId: string; sourceId: string; approvalId: string; requestId: string;
    subjectKey: string; commitSha: string; treeSha: string; planSha256: string }>) => Promise<unknown>;
  getRunV1?: (companyId: string, runId: string, subjectKeySha256: string) => Promise<unknown>;
}>;
type GitProofApi = Readonly<{
  matchWorkspaceSourceV1?: (folderKey: string, sourceId: string) => Promise<unknown>;
  readWorkspaceSourceGitTipV1?: (sourceId: string, folderKey: string, branch: string) => Promise<unknown>;
}>;
type SessionApi = Readonly<{
  getRequest?: (sessionId: string, companyId: string, requestId: string) => Promise<unknown>;
  getRun?: (sessionId: string, companyId: string, runId: string) => Promise<unknown>;
}>;
type QaPlatform = SpsPlatformInvocationContext & Readonly<{ protectedTests?: ProtectedTestsApi; localFolders?: GitProofApi;
  agents: SpsPlatformInvocationContext["agents"] & { sessions: SessionApi;
    owned?: { get?: (input: { companyId: string; pluginAgentKey: string }) => Promise<unknown> } } }>;

type Input = Readonly<{ projectId?: string; ctoId?: string; workstreamId?: string; qaTaskId?: string;
  approvalId: string; planSha256: string; runId?: string }>;
type Target = Readonly<{ workspaceId: string; projectId: string; ctoId: string; workstreamId: string;
  implementation: TaskPacketRecord; implementationDigest: string; qa: TaskPacketRecord; qaDigest: string;
  qaWorker: TaskWorkerRecord; qaRequestId: string; qaRunId: string; source: Readonly<{ sourceId: string; folderKey: string; branch: string }>;
  commitSha: string; treeSha: string; acceptanceId: string; submissionId: string; subjectKey: string; subjectKeySha256: string;
  requestId: string; approvalId: string; planSha256: string; tipCurrent: boolean; allowTerminalQaRun: boolean;
  assertCurrent(): Promise<void> }>;
export type ProtectedTaskQaTarget = Target;

function inputRecord(value: unknown, read: boolean): Input {
  const row = exactToolRecord(value, read
    ? ["projectId", "ctoId", "workstreamId", "qaTaskId", "approvalId", "planSha256", "runId"]
    : ["approvalId", "planSha256"]);
  const textIds = read ? [row.projectId, row.ctoId, row.workstreamId, row.qaTaskId] : [];
  if (textIds.some(value => typeof value !== "string" || !value.trim() || value.length > 160
    || /[\u0000-\u001f\u007f]/u.test(value)) || typeof row.approvalId !== "string" || !UUID.test(row.approvalId)
    || typeof row.planSha256 !== "string" || !SHA256.test(row.planSha256)
    || (read && (typeof row.runId !== "string" || !UUID.test(row.runId)))) {
    throw new TypeError("Protected Task QA scope requires exact bounded Task IDs and an approved plan ID/hash.");
  }
  return row as unknown as Input;
}

function workerRegistryKey(workspaceId: string, projectId: string, ctoId: string) {
  return { scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder",
    stateKey: taskWorkerRegistryKey(projectId, ctoId) };
}

function unsupported(reason: string) {
  return Object.freeze({ status: "unsupported" as const, reason, executionStarted: false, qaVerdict: "not-established" as const });
}

function hostApiUnsupported(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unsupported|not supported|does not support|unknown (?:host )?(?:operation|method)|method not found|not implemented/iu.test(message);
}

export function parseProtectedRun(value: unknown): ProtectedRun {
  const row = exactToolRecord(value, ["schemaVersion", "kind", "id", "status", "termination", "pins", "receipt", "timestamps", "qaVerdict"]);
  const pins = exactToolRecord(row.pins, ["approvalId", "sourceId", "planSha256", "profileSha256", "commitSha", "treeSha",
    "manifestSha256", "inputTreeSha256", "nodeSha256", "subjectKeySha256", "timeoutMs"]);
  if (row.schemaVersion !== 1 || row.kind !== "protected-node-test-v1" || typeof row.id !== "string" || !UUID.test(row.id)
    || !["queued", "claimed", "running", "cancelling", "succeeded", "failed", "cancelled"].includes(row.status as string)
    || !["not_applicable", "pending", "confirmed"].includes(row.termination as string)
    || typeof pins.approvalId !== "string" || !UUID.test(pins.approvalId)
    || typeof pins.sourceId !== "string" || !UUID.test(pins.sourceId)
    || typeof pins.planSha256 !== "string" || !SHA256.test(pins.planSha256)
    || [pins.profileSha256, pins.manifestSha256, pins.nodeSha256].some(value => typeof value !== "string" || !SHA256.test(value))
    || typeof pins.inputTreeSha256 !== "string" || !SHA.test(pins.inputTreeSha256)
    || !Number.isSafeInteger(pins.timeoutMs) || (pins.timeoutMs as number) < 1
    || typeof pins.commitSha !== "string" || !SHA.test(pins.commitSha)
    || typeof pins.treeSha !== "string" || !SHA.test(pins.treeSha)
    || typeof pins.subjectKeySha256 !== "string" || !SHA256.test(pins.subjectKeySha256)
    || row.qaVerdict !== "not-established") throw new TypeError("Core returned a malformed protected QA run receipt.");
  return value as ProtectedRun;
}

export function deriveProtectedTaskQaRequestIdentity(input: Readonly<{ workspaceId: string; projectId: string; ctoId: string; workstreamId: string;
  implementationTaskId: string; implementationRevision: number; implementationDigest: string; qaTaskId: string; qaRevision: number;
  qaDigest: string; qaAgentId: string; qaSessionId: string; sourceId: string; folderKey: string; branch: string;
  commitSha: string; treeSha: string; acceptanceId: string; submissionId: string }>) {
  const scope = ["builder-protected-task-qa-v1", input.workspaceId, input.projectId, input.ctoId, input.workstreamId,
    input.implementationTaskId, input.implementationRevision, input.implementationDigest, input.qaTaskId, input.qaRevision,
    input.qaDigest, input.qaAgentId, input.qaSessionId, input.sourceId, input.folderKey, input.branch, input.commitSha,
    input.treeSha, input.acceptanceId, input.submissionId];
  const key = digest(scope);
  const subjectKey = `builder-task-qa-v1:${key}`;
  return Object.freeze({ subjectKey, subjectKeySha256: subjectDigest(subjectKey), requestId: `builder-task-qa-v1:${key}` });
}

async function resolveTarget(input: Input, runContext: unknown, platform: SpsPlatformInvocationContext): Promise<Target | ReturnType<typeof unsupported>> {
  let qaActor: Awaited<ReturnType<typeof resolveCurrentTaskWorkerToolCall>> | null = null;
  try { qaActor = await resolveCurrentTaskWorkerToolCall(runContext, platform); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("unsupported:")) return unsupported(error.message.slice("unsupported:".length));
    if (!input.runId) throw error;
  }
  let context: Readonly<{ companyId: string; agentId: string; sessionId: string; runId: string; projectId: string }>;
  let ctoId: string;
  let packets: readonly TaskPacketRecord[];
  let workerRecords: readonly TaskWorkerRecord[];
  let qa: TaskPacketRecord | undefined;
  let assertActorCurrent: () => Promise<void>;
  let authority: Awaited<ReturnType<typeof resolveCtoTaskAuthority>> | null = null;
  let rawRegistry: unknown;

  if (qaActor) {
    if (qaActor.current.worker.role !== "qa") throw new Error("Only the exact current QA Worker may request or observe this Task's protected run.");
    context = qaActor.current.context;
    ctoId = qaActor.current.ctoId;
    qa = qaActor.current.packet;
    packets = qaActor.current.currentPackets;
    workerRecords = qaActor.current.workerRecords;
    assertActorCurrent = qaActor.assertCurrent;
    rawRegistry = await platform.state.get(workerRegistryKey(context.companyId, context.projectId, ctoId));
    if (input.runId && (input.projectId !== context.projectId || input.ctoId !== ctoId
      || input.workstreamId !== qaActor.current.worker.workstreamId || input.qaTaskId !== qa.packet.taskId)) {
      throw new Error("Observation scope must match the exact active QA Worker Task context.");
    }
  } else {
    if (!input.runId || !input.projectId || !input.ctoId || !input.workstreamId || !input.qaTaskId) {
      throw new Error("Protected QA admission requires the exact active QA Worker session.");
    }
    const leadContext = parseLeadToolContext(runContext);
    context = Object.freeze({ ...leadContext, projectId: input.projectId });
    ctoId = input.ctoId;
    authority = await resolveCtoTaskAuthority(input.projectId, ctoId, input.workstreamId, leadContext, platform,
      "builder.read-protected-task-qa");
    const board = await authority.store.current();
    packets = board?.revision.packets ?? [];
    qa = packets.find(item => item.packet.taskId === input.qaTaskId);
    const registryKey = workerRegistryKey(context.companyId, input.projectId, ctoId);
    rawRegistry = await authority.state.get(registryKey);
    workerRecords = parseTaskWorkerRegistry(rawRegistry ?? { schemaVersion: 1, workspaceId: context.companyId,
      projectId: input.projectId, ctoId, revision: 0, records: [] }, context.companyId, input.projectId, ctoId).records;
    const originalBoard = JSON.stringify(board?.revision ?? null);
    assertActorCurrent = async () => {
      await authority!.check();
      const latest = await authority!.store.current();
      if (JSON.stringify(latest?.revision ?? null) !== originalBoard) throw new Error("Task Packet history changed during protected QA observation.");
      if (JSON.stringify(await authority!.state.get(registryKey)) !== JSON.stringify(rawRegistry)) {
        throw new Error("Task Worker registration changed during protected QA observation.");
      }
      await authority!.check();
    };
  }
  const projectId = context.projectId;
  const workstreamId = qaActor?.current.worker.workstreamId ?? input.workstreamId!;
  if (input.runId && (input.projectId !== projectId || input.ctoId !== ctoId || input.workstreamId !== workstreamId
    || input.qaTaskId !== qa?.packet.taskId)) throw new Error("Protected QA observation scope does not match the authenticated current Task.");
  if (!qa) throw new Error("The exact current QA Task Packet is unavailable.");
  if (!qa || qa.packet.kind !== "qa" || !qa.packet.testPlan) throw new Error("The exact current QA Task Packet and test plan are unavailable.");
  if (!packets.includes(qa)) throw new Error("The QA packet is not in the authoritative current Task board.");
  const qaDigest = taskPacketRecordDigest(qa, projectId, ctoId, workstreamId);
  const dependencies = qa.dependencyPins.map(pin => {
    const packet = packets.find(item => item.packet.taskId === pin.taskId);
    if (!packet || packet.packet.revision !== pin.revision
      || taskPacketRecordDigest(packet, projectId, ctoId, workstreamId) !== pin.recordSha256) {
      throw new Error("The current QA Task dependency pins have drifted.");
    }
    return packet;
  });
  const implementations = dependencies.filter(item => item.packet.kind === "development");
  if (implementations.length !== 1) throw new Error("The QA Task must depend on exactly one current development Task.");
  const implementation = implementations[0]!;
  const implementationDigest = taskPacketRecordDigest(implementation, projectId, ctoId, workstreamId);
  const source = implementation.packet.sourceAccess, qaSource = qa.packet.sourceAccess;
  if (!source?.branch || !source.expectedHead || !qaSource || source.sourceId !== qaSource.sourceId
    || source.folderKey !== qaSource.folderKey || source.branch !== qaSource.branch) {
    throw new Error("The QA and development Tasks do not bind the same explicit Workspace Source and branch.");
  }
  const branch = source.branch;

  let accepted: Awaited<ReturnType<typeof readAcceptedTaskSourceForQa>> | Awaited<ReturnType<typeof readCtoTaskSourceSubmission>>;
  try {
    accepted = qaActor
      ? await readAcceptedTaskSourceForQa({ workspaceId: context.companyId, projectId, ctoId, workstreamId,
        task: implementation, packets, workerRecords, state: platform.state as typeof platform.state & import("./solution-revision-store.ts").RevisionState,
        platform, assertCurrent: assertActorCurrent })
      : await readCtoTaskSourceSubmission({ projectId, ctoId, workstreamId, taskId: implementation.packet.taskId }, runContext, platform);
  } catch (error) {
    if (hostApiUnsupported(error)) return unsupported("host-task-source-acceptance-proof-unsupported");
    throw error;
  }
  if (accepted.status !== "accepted" || !accepted.acceptance || !accepted.submission
    || accepted.submission.role !== "worker" || accepted.submission.taskId !== implementation.packet.taskId
    || accepted.submission.packetRecordSha256 !== implementationDigest
    || accepted.acceptance.packetRecordSha256 !== implementationDigest
    || accepted.acceptance.commitSha !== accepted.submission.commitSha || accepted.acceptance.treeSha !== accepted.submission.treeSha) {
    return unsupported(`current-development-acceptance-unavailable:${accepted.status}`);
  }
  const receipt = accepted.acceptance;
  if (receipt.workspaceId !== context.companyId || receipt.projectId !== projectId || receipt.ctoId !== ctoId
    || receipt.workstreamId !== workstreamId || receipt.taskId !== implementation.packet.taskId
    || receipt.source.sourceId !== source.sourceId || receipt.source.folderKey !== source.folderKey
    || receipt.source.branch !== source.branch) throw new Error("The immutable CTO acceptance does not match the exact current development Task/source.");
  if (receipt.dependencyPins.some(pin => {
    const current = packets.find(item => item.packet.taskId === pin.taskId);
    return !current || current.packet.revision !== pin.revision
      || taskPacketRecordDigest(current, projectId, ctoId, workstreamId) !== pin.recordSha256;
  }) || JSON.stringify(receipt.dependencyPins) !== JSON.stringify(implementation.dependencyPins)) {
    throw new Error("The accepted development Task dependency pins have drifted.");
  }

  const registry = parseTaskWorkerRegistry(rawRegistry ?? { schemaVersion: 1, workspaceId: context.companyId,
    projectId, ctoId, revision: 0, records: [] }, context.companyId, projectId, ctoId);
  if (JSON.stringify(registry.records) !== JSON.stringify(workerRecords)) throw new Error("Task Worker registry changed during target resolution.");
  const qaWorkers = registry.records.filter(item => item.role === "qa" && item.workstreamId === workstreamId
    && item.taskId === qa.packet.taskId && item.packetRevision === qa.packet.revision && item.packetRecordSha256 === qaDigest);
  if (qaWorkers.length !== 1) throw new Error("Exactly one prepared QA Worker must match this current QA Task Packet.");
  const qaWorker = qaWorkers[0]!;
  if (qaWorker.agentId === accepted.submission.producer.agentId || qaWorker.sessionId === accepted.submission.producer.sessionId
    || qaWorker.agentId === receipt.receivedBy.agentId || qaWorker.sessionId === receipt.receivedBy.sessionId
    || (!qaActor && (qaWorker.agentId === context.agentId || qaWorker.sessionId === context.sessionId))) {
    throw new Error("The QA Worker must be independent of the implementation producer and CTO acceptance identity.");
  }
  deriveTaskWorkerFileBinding({ workspaceId: context.companyId, projectId, ctoId,
    packet: qa, currentPackets: packets, worker: qaWorker });
  const qaRequestId = taskWorkerRequestId(deriveTaskWorkerFileBinding({ workspaceId: context.companyId, projectId,
    ctoId, packet: qa, currentPackets: packets, worker: qaWorker }));
  const sessions = (platform as QaPlatform).agents.sessions;
  if (typeof sessions.getRequest !== "function" || typeof sessions.getRun !== "function") return unsupported("qa-session-request-run-reader-unavailable");
  const request = await sessions.getRequest(qaWorker.sessionId, context.companyId, qaRequestId);
  const requestRow = request === null ? null : exactToolRecord(request, ["requestId", "state", "runId"]);
  if (!requestRow || requestRow.requestId !== qaRequestId || requestRow.state !== "submitted"
    || typeof requestRow.runId !== "string" || !UUID.test(requestRow.runId)) {
    throw new Error("The prepared QA Worker has no exact authoritative dispatch request and Run.");
  }
  const qaRun = exactToolRecord(await sessions.getRun(qaWorker.sessionId, context.companyId, requestRow.runId),
    ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"], ["execution", "output"]);
  const allowTerminalQaRun = !qaActor && !!input.runId;
  const activeQaRun = qaRun.status === "running" && qaRun.cancellationRequested === false && qaRun.termination === "not_applicable";
  const closedQaRun = allowTerminalQaRun && ["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(qaRun.status as string);
  if (qaRun.runId !== requestRow.runId || (!activeQaRun && !closedQaRun)) {
    throw new Error("The exact prepared QA Worker Run is no longer current or readable.");
  }

  const owned = (platform as QaPlatform).agents.owned;
  if (typeof owned?.get !== "function") return unsupported("owned-qa-agent-reader-unavailable");
  const profileRaw = await owned.get({ companyId: context.companyId, pluginAgentKey: qaWorker.pluginAgentKey });
  const profile = exactToolRecord(profileRaw, ["status", "revision", "agent"], []);
  if (!["created", "resolved"].includes(profile.status as string) || !Number.isSafeInteger(profile.revision)
    || (profile.revision as number) < 1) throw new Error("The current owned QA Agent profile is unavailable.");
  const profileAgent = exactToolRecord(profile.agent, ["agentId", "status"], ["name", "role", "title", "icon", "capabilities",
    "adapterType", "instructions", "executionDefaults"]);
  if (profileAgent.agentId !== qaWorker.agentId || !["idle", "running", "paused"].includes(profileAgent.status as string)) {
    throw new Error("The registered QA Agent is not the current owned profile.");
  }

  const folders = (platform as QaPlatform).localFolders;
  if (typeof folders?.matchWorkspaceSourceV1 !== "function" || typeof folders.readWorkspaceSourceGitTipV1 !== "function") {
    return unsupported("host-source-root-or-git-tip-proof-unavailable");
  }
  const sourceApi = folders;
  let rootRaw: unknown;
  try { rootRaw = await folders.matchWorkspaceSourceV1(source.folderKey, source.sourceId); }
  catch (error) { if (hostApiUnsupported(error)) return unsupported("host-source-root-proof-unsupported"); throw error; }
  const root = exactToolRecord(rootRaw, ["folderKey", "workspaceSourceId", "match"]);
  await assertActorCurrent();
  if (root.folderKey !== source.folderKey || root.workspaceSourceId !== source.sourceId || root.match !== "same_root") {
    throw new Error("The configured Host folder does not prove the exact Workspace Source root.");
  }
  let tipRaw: unknown;
  try { tipRaw = await folders.readWorkspaceSourceGitTipV1(source.sourceId, source.folderKey, source.branch); }
  catch (error) { if (hostApiUnsupported(error)) return unsupported("host-git-tip-proof-unsupported"); throw error; }
  await assertActorCurrent();
  const tip = exactToolRecord(tipRaw, ["status", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"]);
  if (tip.status !== "current") return unsupported(`host-git-tip-proof-${String(tip.status)}`);
  if (tip.sourceId !== source.sourceId || tip.folderKey !== source.folderKey || tip.branch !== source.branch) {
    throw new Error("The Host Git proof does not identify the exact approved Source branch.");
  }
  const tipCurrent = tip.commitSha === receipt.commitSha && tip.treeSha === receipt.treeSha;
  if (!tipCurrent && !input.runId) {
    throw new Error("The accepted immutable commit/tree is no longer the exact current authorized Git branch tip.");
  }
  const identity = deriveProtectedTaskQaRequestIdentity({ workspaceId: context.companyId, projectId, ctoId,
    workstreamId, implementationTaskId: implementation.packet.taskId,
    implementationRevision: implementation.packet.revision, implementationDigest, qaTaskId: qa.packet.taskId,
    qaRevision: qa.packet.revision, qaDigest, qaAgentId: qaWorker.agentId, qaSessionId: qaWorker.sessionId,
    sourceId: source.sourceId, folderKey: source.folderKey, branch: source.branch, commitSha: receipt.commitSha,
    treeSha: receipt.treeSha, acceptanceId: receipt.acceptanceId, submissionId: receipt.submissionId });
  await assertActorCurrent();
  const assertCurrent = async () => {
    await assertActorCurrent();
    const currentRegistry = await platform.state.get(workerRegistryKey(context.companyId, projectId, ctoId));
    if (JSON.stringify(currentRegistry) !== JSON.stringify(rawRegistry)) throw new Error("Task Worker registration changed during protected QA preparation.");
    const latestAcceptance = qaActor
      ? await readAcceptedTaskSourceForQa({ workspaceId: context.companyId, projectId, ctoId, workstreamId,
        task: implementation, packets, workerRecords, state: platform.state as typeof platform.state & import("./solution-revision-store.ts").RevisionState,
        platform, assertCurrent: assertActorCurrent })
      : await readCtoTaskSourceSubmission({ projectId, ctoId, workstreamId, taskId: implementation.packet.taskId }, runContext, platform);
    if (latestAcceptance.status !== "accepted" || latestAcceptance.acceptance?.acceptanceId !== receipt.acceptanceId
      || latestAcceptance.submission?.submissionId !== receipt.submissionId
      || latestAcceptance.submission.commitSha !== receipt.commitSha || latestAcceptance.submission.treeSha !== receipt.treeSha) {
      throw new Error("The durable CTO acceptance/submission changed during protected QA preparation.");
    }
    const currentRequest = await sessions.getRequest!(qaWorker.sessionId, context.companyId, qaRequestId);
    const currentReceipt = currentRequest === null ? null : exactToolRecord(currentRequest, ["requestId", "state", "runId"]);
    if (!currentReceipt || currentReceipt.requestId !== qaRequestId || currentReceipt.state !== "submitted"
      || currentReceipt.runId !== requestRow.runId) throw new Error("The exact QA Worker dispatch request changed during protected QA preparation.");
    const currentRun = exactToolRecord(await sessions.getRun!(qaWorker.sessionId, context.companyId, requestRow.runId as string),
      ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"], ["execution", "output"]);
    const currentRunActive = currentRun.status === "running" && currentRun.cancellationRequested === false
      && currentRun.termination === "not_applicable";
    const currentRunClosed = allowTerminalQaRun && ["succeeded", "failed", "cancelled", "interrupted", "timed_out"]
      .includes(currentRun.status as string);
    if (currentRun.runId !== requestRow.runId || (!currentRunActive && !currentRunClosed)) {
      throw new Error("The exact QA Worker Run is no longer active/readable.");
    }
    const currentProfileRaw = await owned.get!({ companyId: context.companyId, pluginAgentKey: qaWorker.pluginAgentKey });
    const currentProfile = exactToolRecord(currentProfileRaw, ["status", "revision", "agent"], []);
    const currentAgent = exactToolRecord(currentProfile.agent, ["agentId", "status"], ["name", "role", "title", "icon", "capabilities",
      "adapterType", "instructions", "executionDefaults"]);
    if (!["created", "resolved"].includes(currentProfile.status as string) || currentAgent.agentId !== qaWorker.agentId
      || !["idle", "running", "paused"].includes(currentAgent.status as string)) {
      throw new Error("The owned QA Worker identity changed during protected QA preparation.");
    }
    const currentRoot = exactToolRecord(await sourceApi.matchWorkspaceSourceV1!(source.folderKey, source.sourceId),
      ["folderKey", "workspaceSourceId", "match"]);
    const currentTip = exactToolRecord(await sourceApi.readWorkspaceSourceGitTipV1!(source.sourceId, source.folderKey, branch),
      ["status", "sourceId", "folderKey", "branch", "commitSha", "treeSha", "observedAt"]);
    const sourceChanged = currentRoot.match !== "same_root" || currentRoot.folderKey !== source.folderKey
      || currentRoot.workspaceSourceId !== source.sourceId || currentTip.status !== "current"
      || currentTip.sourceId !== source.sourceId || currentTip.folderKey !== source.folderKey || currentTip.branch !== branch;
    const branchMoved = currentTip.status === "current" && (currentTip.commitSha !== receipt.commitSha || currentTip.treeSha !== receipt.treeSha);
    if (sourceChanged || (!input.runId && branchMoved)) {
      throw new Error("The accepted source root or exact branch tip changed during protected QA preparation.");
    }
    await assertActorCurrent();
  };
  const target: Target = Object.freeze({ workspaceId: context.companyId, projectId, ctoId,
    workstreamId, implementation, implementationDigest, qa, qaDigest, qaWorker, qaRequestId,
    qaRunId: requestRow.runId as string, source: Object.freeze({ sourceId: source.sourceId, folderKey: source.folderKey, branch }),
    commitSha: receipt.commitSha, treeSha: receipt.treeSha, acceptanceId: receipt.acceptanceId, submissionId: receipt.submissionId,
    ...identity, approvalId: input.approvalId, planSha256: input.planSha256, tipCurrent, allowTerminalQaRun, assertCurrent });
  return target;
}

function sameRun(run: ProtectedRun, target: Target) {
  return run.pins.approvalId === target.approvalId && run.pins.sourceId === target.source.sourceId
    && run.pins.planSha256 === target.planSha256 && run.pins.commitSha === target.commitSha
    && run.pins.treeSha === target.treeSha && run.pins.subjectKeySha256 === target.subjectKeySha256;
}

function result(run: ProtectedRun, target: Target, status: "queued" | "existing" | "read"): ProtectedTaskQaResult {
  if (!sameRun(run, target)) throw new Error("Core protected run does not match this exact Task, acceptance, approved plan, and source.");
  return Object.freeze({ status, runId: run.id, technicalStatus: run.status, termination: run.termination,
    qaCriteria: taskQaCriteria(target.qa.packet.acceptance, target.qa.packet.testPlan?.passCriteria ?? [], target.implementation.packet.acceptance),
    requestId: target.requestId, approvalId: target.approvalId, planSha256: target.planSha256,
    sourceId: target.source.sourceId, commitSha: target.commitSha, treeSha: target.treeSha,
    sourceFreshness: target.tipCurrent ? "current" : "stale",
    qaExecution: run.status === "queued" ? "queued" : run.status === "claimed" || run.status === "running" ? "started" : "finished",
    qaVerdict: "not-established" as const, receipt: run.receipt });
}

export async function enqueueBoundProtectedTaskQa(input: Readonly<{ target: Target;
  enqueue(request: Parameters<NonNullable<ProtectedTestsApi["enqueueApprovedV1"]>>[0]): Promise<unknown> }>): Promise<ProtectedTaskQaResult> {
  const { target } = input;
  try { await target.assertCurrent(); }
  catch { return Object.freeze({ status: "stale", reason: "task-authority-changed-before-enqueue",
    requestId: target.requestId, executionStarted: false, qaVerdict: "not-established" as const }); }
  try {
    const run = parseProtectedRun(await input.enqueue({ companyId: target.workspaceId, sourceId: target.source.sourceId,
      approvalId: target.approvalId, requestId: target.requestId, subjectKey: target.subjectKey,
      commitSha: target.commitSha, treeSha: target.treeSha, planSha256: target.planSha256 }));
    if (!sameRun(run, target)) throw new Error("Core returned a protected run for different Task/source/plan pins.");
    try { await target.assertCurrent(); }
    catch { return Object.freeze({ ...result(run, target, "existing"), status: "stale", reason: "task-authority-changed-after-enqueue" }); }
    return result(run, target, "queued");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (hostApiUnsupported(message)) {
      return unsupported("host-protected-enqueue-unsupported");
    }
    return Object.freeze({ status: "unknown", reason: "enqueue-outcome-unknown-retry-only-same-derived-request",
      requestId: target.requestId, subjectKeySha256: target.subjectKeySha256, executionStarted: null,
      qaVerdict: "not-established" as const });
  }
}

export async function readBoundProtectedTaskQa(input: Readonly<{ target: Target; runId: string;
  getRun(companyId: string, runId: string, subjectKeySha256: string): Promise<unknown> }>): Promise<ProtectedTaskQaResult> {
  await input.target.assertCurrent();
  const raw = await input.getRun(input.target.workspaceId, input.runId, input.target.subjectKeySha256);
  if (raw === null) {
    await input.target.assertCurrent();
    return Object.freeze({ status: "not-found", runId: input.runId, qaVerdict: "not-established" as const });
  }
  const run = parseProtectedRun(raw);
  try { await input.target.assertCurrent(); }
  catch { return Object.freeze({ ...result(run, input.target, "read"), status: "stale", reason: "task-authority-changed-during-observation" }); }
  const readResult = result(run, input.target, "read");
  return input.target.tipCurrent ? readResult : Object.freeze({ ...readResult, status: "stale",
    reason: "accepted-source-is-no-longer-current-branch-tip" });
}

export async function resolveProtectedTaskQaObservation(params: unknown, runContext: unknown,
  platform: SpsPlatformInvocationContext): Promise<Readonly<{ status: "current" | "stale" | "unsupported"; target: Target | null;
    reason?: string; qaVerdict: "not-established" }>> {
  const input = inputRecord(params, true);
  const target = await resolveTarget(input, runContext, platform);
  if ("status" in target) return Object.freeze({ status: "unsupported", target: null, reason: target.reason,
    qaVerdict: "not-established" });
  await target.assertCurrent();
  return Object.freeze({ status: target.tipCurrent ? "current" : "stale", target,
    ...(target.tipCurrent ? {} : { reason: "accepted-source-is-no-longer-current-branch-tip" }), qaVerdict: "not-established" });
}

async function readHistoricalTaskQaRun(input: Input, runContext: unknown, platform: SpsPlatformInvocationContext) {
  let workerCall: Awaited<ReturnType<typeof resolveCurrentTaskWorkerToolCall>> | null = null;
  try { workerCall = await resolveCurrentTaskWorkerToolCall(runContext, platform); } catch { /* terminal QA runs use CTO read authority */ }
  let workspaceId: string;
  let assertCurrent: () => Promise<void>;
  if (workerCall) {
    const context = workerCall.current.context;
    if (workerCall.current.worker.role !== "qa" || !input.projectId || !input.ctoId || !input.workstreamId || !input.qaTaskId
      || context.projectId !== input.projectId || workerCall.current.ctoId !== input.ctoId
      || workerCall.current.worker.workstreamId !== input.workstreamId || workerCall.current.worker.taskId !== input.qaTaskId) {
      throw new Error("Historical observation requires the exact active current QA Worker or its CTO.");
    }
    workspaceId = context.companyId;
    assertCurrent = workerCall.assertCurrent;
  } else {
    const context = parseLeadToolContext(runContext);
    if (!input.projectId || !input.ctoId || !input.workstreamId) throw new Error("Historical QA read requires an exact active CTO Workstream scope.");
    const authority = await resolveCtoTaskAuthority(input.projectId, input.ctoId, input.workstreamId, context, platform,
      "builder.read-protected-task-qa");
    workspaceId = context.companyId;
    assertCurrent = authority.check;
  }
  const api = (platform as QaPlatform).protectedTests;
  if (typeof api?.getRunV1 !== "function") return unsupported("protected-run-reader-api-unavailable");
  const scope = { workspaceId, projectId: input.projectId!, ctoId: input.ctoId!, workstreamId: input.workstreamId!, qaTaskId: input.qaTaskId! };
  const store = createTaskQaRunReferenceStore(scope, platform.state as typeof platform.state & import("./solution-revision-store.ts").RevisionState);
  await assertCurrent();
  const found = await store.findRun(input.runId!);
  await assertCurrent();
  if (found.status === "not-found") return Object.freeze({ status: "not-found", runId: input.runId, qaVerdict: "not-established" as const });
  if (found.status !== "found") return Object.freeze({ status: "unknown", runId: input.runId,
    reason: found.status === "conflict" ? "multiple-task-references-for-core-run" : found.reason,
    qaVerdict: "not-established" as const });
  const reference: TaskQaRunReference = found.reference;
  const binding = reference.binding;
  if (binding.approvalId !== input.approvalId || binding.planSha256 !== input.planSha256) {
    return Object.freeze({ status: "not-found", runId: input.runId, qaVerdict: "not-established" as const });
  }
  const raw = await api.getRunV1(workspaceId, input.runId!, binding.subjectKeySha256);
  if (raw === null) {
    await assertCurrent();
    return Object.freeze({ status: "not-found", runId: input.runId, qaVerdict: "not-established" as const });
  }
  const run = parseProtectedRun(raw);
  if (run.id !== binding.runId || run.pins.approvalId !== binding.approvalId || run.pins.sourceId !== binding.sourceId
    || run.pins.planSha256 !== binding.planSha256 || run.pins.commitSha !== binding.commitSha || run.pins.treeSha !== binding.treeSha
    || run.pins.subjectKeySha256 !== binding.subjectKeySha256) throw new Error("Core historical run does not match its immutable Task reference.");
  try { await assertCurrent(); }
  catch { return Object.freeze({ status: "stale", runId: run.id, technicalStatus: run.status, termination: run.termination,
    sourceFreshness: "historical", reference: binding, receipt: run.receipt, reason: "observer-authority-changed-during-read",
    qaVerdict: "not-established" as const }); }
  return Object.freeze({ status: "historical", runId: run.id, technicalStatus: run.status, termination: run.termination,
    sourceFreshness: "historical", reference: binding, receipt: run.receipt, qaVerdict: "not-established" as const });
}

export async function requestProtectedTaskQa(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = inputRecord(params, false);
  const target = await resolveTarget(input, runContext, platform);
  if ("status" in target) return target;
  const api = (platform as QaPlatform).protectedTests;
  if (typeof api?.enqueueApprovedV1 !== "function") return unsupported("protected-approved-enqueue-api-unavailable");
  const queued = await enqueueBoundProtectedTaskQa({ target, enqueue: request => api.enqueueApprovedV1!(request) });
  if (queued.status !== "queued" || typeof queued.runId !== "string") return queued;
  try {
    const reference = await recordTaskQaRunReference(platform.state as typeof platform.state & import("./solution-revision-store.ts").RevisionState,
      target, queued.runId);
    if (["unknown", "conflict", "stale"].includes(reference.status)) {
      return Object.freeze({ ...queued, taskRunReference: reference.status,
        referenceReason: "reason" in reference ? reference.reason : undefined,
        qaVerdict: "not-established" as const });
    }
    return Object.freeze({ ...queued, taskRunReference: reference.status, qaVerdict: "not-established" as const });
  } catch {
    return Object.freeze({ ...queued, taskRunReference: "unknown", referenceReason: "reference-publication-outcome-unknown",
      qaVerdict: "not-established" as const });
  }
}

export async function readProtectedTaskQa(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = inputRecord(params, true);
  let observation: Awaited<ReturnType<typeof resolveProtectedTaskQaObservation>>;
  try { observation = await resolveProtectedTaskQaObservation(params, runContext, platform); }
  catch {
    return readHistoricalTaskQaRun(input, runContext, platform);
  }
  if (!observation.target) {
    const historical = await readHistoricalTaskQaRun(input, runContext, platform);
    return historical.status === "not-found" ? unsupported(observation.reason ?? "task-bound-protected-qa-observation-unavailable") : historical;
  }
  const target = observation.target;
  const api = (platform as QaPlatform).protectedTests;
  if (typeof api?.getRunV1 !== "function") return unsupported("protected-run-reader-api-unavailable");
  try {
    const read = await readBoundProtectedTaskQa({ target, runId: input.runId!, getRun: (workspaceId, runId, subjectHash) =>
      api.getRunV1!(workspaceId, runId, subjectHash) });
    return observation.status === "stale" && read.status !== "not-found"
      ? Object.freeze({ ...read, status: "stale", reason: observation.reason }) : read;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (hostApiUnsupported(message)) {
      return unsupported("host-protected-run-reader-unsupported");
    }
    return Object.freeze({ status: "unknown", runId: input.runId, reason: "protected-run-observation-unknown",
      qaVerdict: "not-established" as const });
  }
}
