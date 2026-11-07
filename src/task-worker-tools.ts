import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey, type TaskWorkerRecord, type TaskWorkerRole } from "./domain/task-workers.ts";
import { parseTaskPacketRecord, taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { exactToolRecord, parseLeadToolContext } from "./lead-tool-authority.ts";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { parseLeadSessions } from "./domain/lead-sessions.ts";
import { integrationManagerSessionStateKey, legacyIntegrationManagerSessionStateKey,
  integrationManagerStateKey, parseIntegrationManagerBinding, parseIntegrationManagerSessionBinding } from "./domain/integration-manager.ts";
import { readProjectCtos } from "./project-cto-tools.ts";
import { resolveCtoTaskAuthority, createTaskPacketStore } from "./task-packet-tools.ts";
import type { RevisionState } from "./solution-revision-store.ts";
import { readWorkstreams } from "./workstream-tools.ts";
import { createCtoDeliveryStore, workstreamInstructionDigest } from "./cto-delivery-store.ts";
import { deriveTaskWorkerFileBinding, taskWorkerRequestId, dispatchTaskWorkerSession,
  readTaskWorkerSourceFile, writeTaskWorkerSourceFile, deleteTaskWorkerSourceFile,
  type TaskWorkerFileBinding } from "./task-worker-runtime.ts";
import { assertSessionExecutionPolicySupport } from "./session-execution-policy.ts";

const asJson = (value: unknown) => value as JsonValue;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type OwnedClient = {
  get(input: { companyId: string; pluginAgentKey: string }): Promise<unknown>;
  ensure(input: { companyId: string; pluginAgentKey: string; adapterPreference?: readonly string[];
    config: { name: string; role: "engineer"; title: string; instructions: string } }): Promise<unknown>;
};
const ownedClient = (platform: SpsPlatformInvocationContext) =>
  (platform.agents as typeof platform.agents & { owned?: OwnedClient }).owned;

function agentReceipt(value: unknown): { status: string; agentId: string } | null {
  const row = exactToolRecord(value, ["status"], ["revision", "agent"]);
  if ((row.status !== "created" && row.status !== "resolved") || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1) return null;
  const agent = exactToolRecord(row.agent, ["agentId", "status"],
    ["name", "role", "title", "icon", "capabilities", "adapterType", "instructions", "executionDefaults"]);
  if (typeof agent.agentId !== "string" || !uuid.test(agent.agentId) || typeof agent.status !== "string") return null;
  return { status: agent.status, agentId: agent.agentId };
}

function keyFor(projectId: string, workstreamId: string, taskId: string, role: TaskWorkerRole) {
  const digest = hash([projectId, workstreamId, taskId, role]);
  return `builder-task-${role}:${digest}`;
}

async function prepareAuthority(input: { projectId: string; ctoId: string; workstreamId: string }, runContext: unknown,
  platform: SpsPlatformInvocationContext, operation: "prepare" | "read" | "dispatch") {
  const context = parseLeadToolContext(runContext);
  const toolName = operation === "prepare" ? "builder.prepare-task-worker"
    : operation === "dispatch" ? "builder.dispatch-task-worker" : "builder.read-task-workers";
  const authority = await resolveCtoTaskAuthority(input.projectId, input.ctoId, input.workstreamId, context, platform,
    toolName);
  return { context, authority, store: authority.store };
}

function registryKey(workspaceId: string, projectId: string, ctoId: string) {
  return { scopeKind: "company" as const, scopeId: workspaceId, namespace: "sonpark.my-builder",
    stateKey: taskWorkerRegistryKey(projectId, ctoId) };
}

function dependenciesMatchCurrent(record: TaskPacketRecord, packets: readonly TaskPacketRecord[]) {
  return record.dependencyPins.every(pin => {
    const dependency = packets.find(candidate => candidate.packet.taskId === pin.taskId);
    return dependency?.packet.revision === pin.revision
      && taskPacketRecordDigest(dependency, record.packet.projectId, record.packet.ctoId, record.packet.workstreamId) === pin.recordSha256;
  });
}

type TaskWorkerToolContext = Readonly<{ companyId: string; agentId: string; runId: string; sessionId: string; projectId: string }>;
type CurrentTaskWorkerBinding = Readonly<{ context: TaskWorkerToolContext; ctoId: string; worker: TaskWorkerRecord;
  packet: TaskPacketRecord; binding: TaskWorkerFileBinding }>;

function parseTaskWorkerToolContext(value: unknown): TaskWorkerToolContext {
  const row = exactToolRecord(value, ["companyId", "agentId", "runId", "sessionId"], ["projectId"]);
  if (![row.companyId, row.agentId, row.runId, row.sessionId].every(value => typeof value === "string" && uuid.test(value))) {
    throw new TypeError("A trusted active Host Agent run and session are required.");
  }
  const projectId = row.projectId ?? row.companyId;
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 160
    || /[\u0000-\u001f\u007f]/u.test(projectId)) throw new TypeError("A trusted Workspace-scoped Worker session is required.");
  return Object.freeze({ companyId: row.companyId as string, agentId: row.agentId as string, runId: row.runId as string,
    sessionId: row.sessionId as string, projectId });
}

function taskRuntimeStateKey(companyId: string, stateKey: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "sonpark.my-builder", stateKey };
}

function currentActiveRun(value: unknown, context: TaskWorkerToolContext) {
  const row = exactToolRecord(value, ["runId", "status", "cancellationRequested", "termination", "errorCode", "error"], ["execution", "output"]);
  if (row.runId !== context.runId || row.status !== "running" || row.cancellationRequested !== false
    || row.termination !== "not_applicable") throw new Error("Task file tools require the active uncancelled Worker/QA Run.");
}

async function assertOtherRoleContext(context: TaskWorkerToolContext, ctos: Awaited<ReturnType<typeof readProjectCtos>>,
  platform: SpsPlatformInvocationContext, owned: OwnedClient) {
  if (ctos.ctos.some(cto => cto.agentId === context.agentId || cto.sessionId === context.sessionId)) {
    throw new Error("A CTO identity or session cannot use Task Worker file tools.");
  }
  const lead = parseLeadAgentBinding(await platform.state.get(taskRuntimeStateKey(context.companyId, "lead-agent.v1")) ?? {
    workspaceId: context.companyId, revision: 0, selectedAgentId: null,
  }, context.companyId);
  if (lead.selectedAgentId === context.agentId) throw new Error("The Lead identity cannot use Task Worker file tools.");
  const leadSessions = parseLeadSessions(await platform.state.get(taskRuntimeStateKey(context.companyId,
    `lead-sessions.v1.${lead.revision}`)) ?? { workspaceId: context.companyId, selectionRevision: lead.revision,
    agentId: lead.selectedAgentId, sessions: { main: null, "ui-design": null, background: null,
      "cto-inbox": null, decisions: null, "integration-review": null } }, context.companyId);
  if (Object.values(leadSessions.sessions).includes(context.sessionId)) throw new Error("A Lead session cannot use Task Worker file tools.");

  const managerBinding = parseIntegrationManagerBinding(await platform.state.get(integrationManagerStateKey(context.companyId)) ?? {
    schemaVersion: 1, workspaceId: context.companyId, revision: 0, selectedAgentId: null,
  }, context.companyId);
  const rawManager = await owned.get({ companyId: context.companyId, pluginAgentKey: "integration-manager" });
  const managerProfile = (rawManager as { status?: unknown })?.status === "missing" ? null : agentReceipt(rawManager);
  if ((rawManager as { status?: unknown })?.status !== "missing" && !managerProfile) {
    throw new Error("Current Manager owned identity could not be verified.");
  }
  if (managerBinding.selectedAgentId && managerProfile && managerBinding.selectedAgentId !== managerProfile.agentId) {
    throw new Error("Current Manager identity binding is inconsistent.");
  }
  const managerAgentId = managerBinding.selectedAgentId ?? managerProfile?.agentId ?? null;
  if (managerAgentId === context.agentId) throw new Error("The Manager identity cannot use Task Worker file tools.");
  if (managerAgentId) {
    for (const key of [integrationManagerSessionStateKey(context.companyId, context.projectId, managerAgentId),
      legacyIntegrationManagerSessionStateKey(context.companyId, context.projectId)]) {
      const raw = await platform.state.get(key);
      if (raw === null) continue;
      const session = parseIntegrationManagerSessionBinding(raw, context.companyId, context.projectId);
      if (session.managerAgentId === managerAgentId && session.sessionId === context.sessionId) {
        throw new Error("The Manager session cannot use Task Worker file tools.");
      }
    }
  }
}

async function readCurrentTaskWorkerBinding(context: TaskWorkerToolContext, platform: SpsPlatformInvocationContext): Promise<CurrentTaskWorkerBinding> {
  const sessions = platform.agents.sessions as typeof platform.agents.sessions & {
    describePolicySupport?: (sessionId: string, companyId: string) => Promise<unknown>;
    getRequest?: (sessionId: string, companyId: string, requestId: string) => Promise<null | { requestId: string;
      state: "pending" | "submitted" | "uncertain"; runId: string | null }>;
  };
  const owned = ownedClient(platform);
  if (typeof sessions.describePolicySupport !== "function" || typeof sessions.getRequest !== "function"
    || typeof sessions.getRun !== "function" || typeof owned?.get !== "function") {
    throw new Error("unsupported:task-worker-run-or-owned-agent-observation-unavailable");
  }
  try { await assertSessionExecutionPolicySupport(platform, context.sessionId, context.companyId); }
  catch { throw new Error("unsupported:restricted-task-worker-session-policy-unavailable"); }
  currentActiveRun(await sessions.getRun(context.sessionId, context.companyId, context.runId), context);

  const ctos = await readProjectCtos(context.companyId, context.projectId, platform);
  await assertOtherRoleContext(context, ctos, platform, owned);
  const matches: Array<{ ctoId: string; worker: TaskWorkerRecord }> = [];
  for (const cto of ctos.ctos) {
    const key = registryKey(context.companyId, context.projectId, cto.ctoId);
    const raw = await platform.state.get(key);
    const registry = parseTaskWorkerRegistry(raw ?? { schemaVersion: 1, workspaceId: context.companyId,
      projectId: context.projectId, ctoId: cto.ctoId, revision: 0, records: [] }, context.companyId, context.projectId, cto.ctoId);
    const related = registry.records.filter(item => item.agentId === context.agentId || item.sessionId === context.sessionId);
    if (related.some(item => item.agentId !== context.agentId || item.sessionId !== context.sessionId)) {
      throw new Error("Task Worker Agent and session identity do not match as one registered pair.");
    }
    const logical = new Set(related.map(item => JSON.stringify([item.workstreamId, item.taskId, item.role])));
    if (logical.size > 1) throw new Error("One Host session is registered to multiple Task Worker roles.");
    if (!related.length) continue;
    const latest = related.at(-1)!;
    matches.push({ ctoId: cto.ctoId, worker: latest });
  }
  if (matches.length !== 1) throw new Error("The active Host run must match exactly one registered Task Worker or QA identity.");
  const { ctoId, worker } = matches[0]!;
  const cto = ctos.ctos.find(item => item.ctoId === ctoId)!;
  if (cto.status !== "ACTIVE" || cto.agentId === context.agentId || cto.sessionId === context.sessionId) {
    throw new Error("Task Worker authority is historical or overlaps a current CTO identity.");
  }
  const profile = agentReceipt(await owned.get({ companyId: context.companyId, pluginAgentKey: worker.pluginAgentKey }));
  if (!profile || profile.agentId !== context.agentId || !["idle", "running", "paused"].includes(profile.status)) {
    throw new Error("The current Host-owned Task Worker identity is unavailable or changed.");
  }
  const visibleAgents = await platform.agents.list({ companyId: context.companyId, limit: 100 });
  if (!Array.isArray(visibleAgents) || visibleAgents.length > 100
    || !visibleAgents.some(agent => agent.id === context.agentId && agent.status === profile.status)) {
    throw new Error("The Task Worker identity is no longer visible in the current Workspace.");
  }

  const workstreams = await readWorkstreams(context.companyId, context.projectId, platform);
  const workstream = workstreams?.revision.workstreams.find(item => item.spec.id === worker.workstreamId);
  const delivery = await createCtoDeliveryStore(context.companyId, context.projectId, ctoId, platform.state).current();
  if (!workstream || workstream.spec.assignedCtoId !== ctoId || workstream.ctoAgentId !== cto.agentId
    || workstream.ctoSessionId !== cto.sessionId || !delivery || delivery.revision.phase === "prepared"
    || delivery.revision.instruction.spec.id !== worker.workstreamId || delivery.revision.instruction.ctoAgentId !== cto.agentId
    || delivery.revision.instruction.ctoSessionId !== cto.sessionId
    || workstreamInstructionDigest(workstream) !== workstreamInstructionDigest(delivery.revision.instruction)) {
    throw new Error("The Task Workstream or its current CTO delivery pins are missing or changed.");
  }
  const packetStore = createTaskPacketStore(context.companyId, context.projectId, ctoId, worker.workstreamId,
    platform.state as typeof platform.state & RevisionState);
  const board = await packetStore.current();
  const packet = board?.revision.packets.find(item => item.packet.taskId === worker.taskId);
  if (!packet || packet.packet.revision !== worker.packetRevision || packet.source.requestId !== delivery.revision.requestId
    || packet.source.workstreamId !== worker.workstreamId || packet.source.specRevision !== delivery.revision.instruction.spec.revision
    || packet.source.instructionSha256 !== workstreamInstructionDigest(delivery.revision.instruction)
    || taskPacketRecordDigest(packet, context.projectId, ctoId, worker.workstreamId) !== worker.packetRecordSha256
    || !dependenciesMatchCurrent(packet, board!.revision.packets)) {
    throw new Error("The active Worker registration does not match the exact current packet, Workstream source or dependency pins.");
  }
  const binding = deriveTaskWorkerFileBinding({ workspaceId: context.companyId, projectId: context.projectId, ctoId,
    packet, currentPackets: board!.revision.packets, worker });
  const requestId = taskWorkerRequestId(binding);
  const request = await sessions.getRequest(context.sessionId, context.companyId, requestId);
  if (!request || request.requestId !== requestId || request.state !== "submitted" || request.runId !== context.runId) {
    throw new Error("The active Run is not the exact current Task dispatch request for this Worker identity.");
  }
  return Object.freeze({ context, ctoId, worker, packet, binding });
}

async function resolveTaskWorkerFileCall(runContext: unknown, platform: SpsPlatformInvocationContext) {
  const context = parseTaskWorkerToolContext(runContext);
  let current = await readCurrentTaskWorkerBinding(context, platform);
  const assertCurrent = async () => {
    const latest = await readCurrentTaskWorkerBinding(context, platform);
    if (latest.ctoId !== current.ctoId || latest.worker.agentId !== current.worker.agentId
      || latest.worker.sessionId !== current.worker.sessionId || latest.worker.role !== current.worker.role
      || latest.binding.packetRecordSha256 !== current.binding.packetRecordSha256
      || latest.binding.packetRevision !== current.binding.packetRevision) {
      throw new Error("Current Task Worker, packet or source authority changed during the file operation.");
    }
    current = latest;
  };
  return { current, assertCurrent };
}

function taskToolUnsupported(reason: string) {
  return { content: "Task Worker integration is unsupported by the current Host API. No fallback was used.",
    data: asJson({ status: "unsupported", reason, executionStarted: false, completion: "not-established",
      qaVerdict: "not-established" }) };
}

function taskFileResult(result: { status: string; reason?: string; text?: string }) {
  const content = result.status === "read" ? "Read the exact Task-authorized source file." :
    result.status === "written" ? "Atomically wrote the exact Task-authorized source file; no Git commit or test was performed." :
    result.status === "deleted" ? "Deleted the exact Task-authorized source file; no Git commit or test was performed." :
    result.status === "unknown" ? "The file operation may have taken effect, but current authority or folder identity changed. Re-read state; do not retry automatically." :
    "The current Host does not support this Task file operation.";
  return { content, data: asJson({ status: result.status, ...(result.reason ? { reason: result.reason } : {}),
    ...(result.text !== undefined ? { text: result.text } : {}), completion: "not-established", qaVerdict: "not-established" }) };
}

export async function readTaskWorkerFile(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["relativePath"]);
  if (typeof input.relativePath !== "string") throw new TypeError("relativePath must be a string.");
  let call: Awaited<ReturnType<typeof resolveTaskWorkerFileCall>>;
  try { call = await resolveTaskWorkerFileCall(runContext, platform); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("unsupported:")) return taskToolUnsupported(error.message.slice("unsupported:".length));
    throw error;
  }
  return taskFileResult(await readTaskWorkerSourceFile({ platform, binding: call.current.binding,
    relativePath: input.relativePath, assertCurrent: call.assertCurrent }));
}

export async function writeTaskWorkerFile(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["relativePath", "contents"]);
  if (typeof input.relativePath !== "string" || typeof input.contents !== "string") throw new TypeError("relativePath and contents must be strings.");
  let call: Awaited<ReturnType<typeof resolveTaskWorkerFileCall>>;
  try { call = await resolveTaskWorkerFileCall(runContext, platform); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("unsupported:")) return taskToolUnsupported(error.message.slice("unsupported:".length));
    throw error;
  }
  return taskFileResult(await writeTaskWorkerSourceFile({ platform, binding: call.current.binding,
    relativePath: input.relativePath, contents: input.contents, assertCurrent: call.assertCurrent }));
}

export async function deleteTaskWorkerFile(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["relativePath"]);
  if (typeof input.relativePath !== "string") throw new TypeError("relativePath must be a string.");
  let call: Awaited<ReturnType<typeof resolveTaskWorkerFileCall>>;
  try { call = await resolveTaskWorkerFileCall(runContext, platform); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("unsupported:")) return taskToolUnsupported(error.message.slice("unsupported:".length));
    throw error;
  }
  return taskFileResult(await deleteTaskWorkerSourceFile({ platform, binding: call.current.binding,
    relativePath: input.relativePath, assertCurrent: call.assertCurrent }));
}

/** CTO-authorized one-time dispatch for the exact current prepared packet and role. */
export async function dispatchPreparedTaskWorker(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "taskId", "packetRevision", "role"]);
  const projectId = bounded(input.projectId), ctoId = bounded(input.ctoId), workstreamId = bounded(input.workstreamId), taskId = bounded(input.taskId);
  if (!Number.isSafeInteger(input.packetRevision) || (input.packetRevision as number) < 1) throw new TypeError("packetRevision must be a positive safe integer.");
  if (input.role !== "worker" && input.role !== "qa") throw new TypeError("role must be worker or qa.");
  const role = input.role as TaskWorkerRole, packetRevision = input.packetRevision as number;
  const prepared = await prepareAuthority({ projectId, ctoId, workstreamId }, runContext, platform, "dispatch");
  const { context, authority, store } = prepared;
  const readCurrent = async () => {
    await authority.check();
    const board = await store.current();
    const packet = board?.revision.packets.find(item => item.packet.taskId === taskId);
    if (!packet || packet.packet.revision !== packetRevision || packet.source.requestId !== authority.source.requestId
      || packet.source.specRevision !== authority.source.specRevision || packet.source.instructionSha256 !== authority.source.sha256
      || (role === "worker" ? packet.packet.kind !== "development" : packet.packet.kind !== "qa")
      || !dependenciesMatchCurrent(packet, board!.revision.packets)) {
      throw new Error("Dispatch requires the exact current Task Packet revision and dependency/source pins.");
    }
    const raw = await platform.state.get(registryKey(context.companyId, projectId, ctoId));
    const registry = parseTaskWorkerRegistry(raw ?? { schemaVersion: 1, workspaceId: context.companyId,
      projectId, ctoId, revision: 0, records: [] }, context.companyId, projectId, ctoId);
    const history = registry.records.filter(item => item.workstreamId === workstreamId && item.taskId === taskId && item.role === role);
    const worker = history.at(-1);
    const digest = taskPacketRecordDigest(packet, projectId, ctoId, workstreamId);
    if (!worker || worker.packetRevision !== packetRevision || worker.packetRecordSha256 !== digest
      || worker.source.requestId !== authority.source.requestId || worker.source.specRevision !== authority.source.specRevision
      || worker.source.instructionSha256 !== authority.source.sha256) {
      throw new Error("Dispatch requires the exact current prepared Task Worker role and identity.");
    }
    const binding = deriveTaskWorkerFileBinding({ workspaceId: context.companyId, projectId, ctoId, packet,
      currentPackets: board!.revision.packets, worker });
    const owned = ownedClient(platform);
    if (typeof owned?.get !== "function") throw new Error("unsupported:owned-task-worker-profile-reader-unavailable");
    const profile = agentReceipt(await owned.get({ companyId: context.companyId, pluginAgentKey: worker.pluginAgentKey }));
    if (!profile || profile.agentId !== worker.agentId || !["idle", "running", "paused"].includes(profile.status)) {
      throw new Error("The prepared Task Worker owned identity changed or is inactive.");
    }
    await authority.check();
    return { board, packet, worker, binding, registry, raw };
  };
  const initial = await readCurrent();
  const assertCurrent = async () => {
    const latest = await readCurrent();
    if (latest.worker.agentId !== initial.worker.agentId || latest.worker.sessionId !== initial.worker.sessionId
      || latest.binding.packetRecordSha256 !== initial.binding.packetRecordSha256
      || latest.registry.revision !== initial.registry.revision) {
      throw new Error("Task Worker registry, packet or dependency authority changed during dispatch.");
    }
  };
  const result = await dispatchTaskWorkerSession({ platform, binding: initial.binding, packet: initial.packet, assertCurrent });
  const content = result.status === "submitted" ? "Dispatched one restricted Task Worker session Run. No implementation result, Git commit, protected test or QA pass is established."
    : result.status === "existing" ? "The exact deterministic Task Worker request already exists; no duplicate Run was sent."
    : result.status === "unknown" ? "Dispatch state is uncertain. Reconcile the same request; do not retry automatically."
    : "Task Worker dispatch is unsupported by the current Host API. No fallback was used.";
  return { content, data: asJson({ ...result, packetRevision, taskId, role, completion: "not-established",
    qaVerdict: "not-established", gitCommit: "not-established", protectedTest: "not-established" }) };
}

/** Registers a distinct Host-owned identity/session for the exact current packet; never starts a run. */
export async function prepareTaskWorker(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId", "taskId", "packetRevision", "role"]);
  const projectId = bounded(input.projectId), ctoId = bounded(input.ctoId), workstreamId = bounded(input.workstreamId), taskId = bounded(input.taskId);
  if (!Number.isSafeInteger(input.packetRevision) || (input.packetRevision as number) < 1) {
    throw new TypeError("packetRevision must be a positive safe integer.");
  }
  const packetRevision = input.packetRevision as number;
  if (input.role !== "worker" && input.role !== "qa") throw new TypeError("role must be worker or qa.");
  const role = input.role as TaskWorkerRole;
  const prepared = await prepareAuthority({ projectId, ctoId, workstreamId }, runContext, platform, "prepare");
  const { context, authority } = prepared;
  const state = platform.state as typeof platform.state & RevisionState;
  const unsupported = (reason: string) => ({ content: "Task Worker preparation is unsupported by the current Host API. No fallback identity or execution was used.",
    data: asJson({ status: "unsupported", reason, executionStarted: false, qaResult: "not-run" }) });
  const owned = ownedClient(platform);
  const current = await prepared.store.current();
  const packetRecord = current?.revision.packets.find(record => record.packet.taskId === taskId);
  if (!packetRecord || packetRecord.packet.revision !== packetRevision || packetRecord.source.requestId !== authority.source.requestId
    || packetRecord.source.workstreamId !== workstreamId || packetRecord.source.specRevision !== authority.source.specRevision
    || packetRecord.source.instructionSha256 !== authority.source.sha256
    || (role === "worker" ? packetRecord.packet.kind !== "development" : packetRecord.packet.kind !== "qa")) {
    throw new Error("Requested packetRevision is stale or the Task Packet role/source pins do not match the exact current publication.");
  }
  const dependenciesCurrent = dependenciesMatchCurrent(packetRecord, current!.revision.packets);
  if (!dependenciesCurrent) throw new Error("Preparation requires current exact Task Packet dependency pins; dependency drift must be replanned first.");
  if (typeof state.compareAndSet !== "function" || typeof platform.agents.sessions.ensure !== "function"
    || typeof owned?.get !== "function" || typeof owned?.ensure !== "function") return unsupported("owned-agent-or-keyed-session-api-unavailable");
  const packetRecordSha256 = taskPacketRecordDigest(packetRecord, projectId, ctoId, workstreamId);
  const checkExactCurrentPacket = async () => {
    await authority.check();
    const latest = await prepared.store.current();
    const exact = latest?.revision.packets.find(record => record.packet.taskId === taskId);
    if (!exact || exact.packet.revision !== packetRevision || taskPacketRecordDigest(exact, projectId, ctoId, workstreamId) !== packetRecordSha256
      || exact.source.requestId !== authority.source.requestId || exact.source.specRevision !== authority.source.specRevision
      || exact.source.instructionSha256 !== authority.source.sha256
      || !dependenciesMatchCurrent(exact, latest!.revision.packets)) {
      throw new Error("Task Packet revision, source or dependency pins changed during Worker preparation; existing history is preserved.");
    }
    await authority.check();
    return exact;
  };
  const stateKey = registryKey(context.companyId, projectId, ctoId);
  const readRegistry = async () => {
    await authority.check();
    const raw = await platform.state.get(stateKey);
    await authority.check();
    return { raw, registry: parseTaskWorkerRegistry(raw ?? { schemaVersion: 1, workspaceId: context.companyId,
      projectId, ctoId, revision: 0, records: [] }, context.companyId, projectId, ctoId) };
  };
  let snapshot = await readRegistry();
  const prior = snapshot.registry.records.filter(record => record.workstreamId === workstreamId
    && record.taskId === taskId && record.role === role).at(-1);
  const pluginAgentKey = keyFor(projectId, workstreamId, taskId, role);
  await checkExactCurrentPacket();
  const latestProfile = await owned.get({ companyId: context.companyId, pluginAgentKey });
  await authority.check();
  let profile = agentReceipt(latestProfile);
  if (!profile && (latestProfile as { status?: unknown })?.status === "missing" && !prior) {
    let adapterPreference: readonly string[] | undefined;
    try {
      const descriptor = exactToolRecord(await platform.agents.describeExecution(context.agentId, context.companyId),
        ["agentId", "adapterType", "state", "adapterRegistration", "executionOwner", "authorization", "readiness", "node"]);
      if (descriptor.agentId !== context.agentId || descriptor.state !== "configured" || descriptor.adapterRegistration !== "registered"
        || descriptor.executionOwner !== "adapter" || typeof descriptor.adapterType !== "string" || !descriptor.adapterType.trim()) {
        return unsupported("current-cto-adapter-not-confirmed");
      }
      adapterPreference = [descriptor.adapterType];
    } catch { return unsupported("current-cto-adapter-observation-unavailable"); }
    const title = role === "qa" ? "Builder QA" : "Builder Worker";
    await checkExactCurrentPacket();
    await authority.check();
    profile = agentReceipt(await owned.ensure({ companyId: context.companyId, pluginAgentKey, adapterPreference,
      config: { name: `${title} ${taskId}`.slice(0, 120), role: "engineer", title,
        instructions: role === "qa"
          ? "Inspect only the assigned current QA Task Packet and its exact test plan. Registration grants no execution or result authority. Report evidence without claiming a pass until a real independent QA run is verified."
          : "Work only on the assigned current development Task Packet. Registration grants no execution or permission beyond the Host delegation. Do not claim completion without verified evidence." } }));
    await authority.check();
  }
  if (!profile) return unsupported("owned-agent-profile-unavailable");
  if (prior && profile.agentId !== prior.agentId) return unsupported("owned-agent-identity-changed");
  const ctos = await readProjectCtos(context.companyId, projectId, platform);
  const leadBinding = parseLeadAgentBinding(await platform.state.get({ scopeKind: "company", scopeId: context.companyId,
    namespace: "sonpark.my-builder", stateKey: "lead-agent.v1" }) ?? { workspaceId: context.companyId, revision: 0, selectedAgentId: null }, context.companyId);
  if (profile.agentId === context.agentId || profile.agentId === leadBinding.selectedAgentId
    || ctos.ctos.some(cto => cto.agentId === profile!.agentId)
    || snapshot.registry.records.some(record => record.agentId === profile!.agentId
      && !(record.workstreamId === workstreamId && record.taskId === taskId && record.role === role))) {
    return unsupported("owned-agent-identity-conflict");
  }
  let managerAgentId: string | null = null;
  let managerSessionId: string | null = null;
  try {
    const managerBinding = parseIntegrationManagerBinding(await platform.state.get(integrationManagerStateKey(context.companyId)) ?? {
      schemaVersion: 1, workspaceId: context.companyId, revision: 0, selectedAgentId: null,
    }, context.companyId);
    const managerProfileReceipt = await owned.get({ companyId: context.companyId, pluginAgentKey: "integration-manager" });
    const managerProfile = (managerProfileReceipt as { status?: unknown })?.status === "missing" ? null : agentReceipt(managerProfileReceipt);
    if ((managerProfileReceipt as { status?: unknown })?.status !== "missing" && !managerProfile) return unsupported("manager-owned-profile-unavailable");
    if (managerBinding.selectedAgentId && managerProfile && managerBinding.selectedAgentId !== managerProfile.agentId) {
      return unsupported("manager-agent-binding-conflict");
    }
    managerAgentId = managerBinding.selectedAgentId ?? managerProfile?.agentId ?? null;
    if (managerAgentId === profile.agentId) return unsupported("manager-agent-identity-conflict");
    if (managerAgentId) {
      for (const managerKey of [integrationManagerSessionStateKey(context.companyId, projectId, managerAgentId),
        legacyIntegrationManagerSessionStateKey(context.companyId, projectId)]) {
        const rawManagerSession = await platform.state.get(managerKey);
        if (rawManagerSession === null) continue;
        const managerSession = parseIntegrationManagerSessionBinding(rawManagerSession, context.companyId, projectId);
        if (managerSession.managerAgentId === managerAgentId) {
          managerSessionId = managerSession.sessionId;
          break;
        }
      }
    }
  } catch { return unsupported("manager-identity-observation-unavailable"); }
  if (!(["idle", "running", "paused"].includes(profile.status))) return unsupported("owned-agent-profile-inactive");
  const agents = await platform.agents.list({ companyId: context.companyId, limit: 100 });
  await authority.check();
  if (!Array.isArray(agents) || agents.length > 100 || agents.some(agent => agent.companyId !== context.companyId)
    || !agents.some(agent => agent.id === profile!.agentId && agent.status === profile!.status)) return unsupported("owned-agent-not-currently-visible");

  await checkExactCurrentPacket();
  await authority.check();
  const sessionTaskKey = `plugin:com.sonparkserver.my-plugin-builder:session:${pluginAgentKey}`;
  const ensureTaskSession = platform.agents.sessions.ensure as (agentId: string, companyId: string, options: {
    taskKey: string; expectedSessionId?: string; context?: { projectId: string };
  }) => Promise<{ sessionId: string; created: boolean }>;
  const session = exactToolRecord(await ensureTaskSession.call(platform.agents.sessions, profile.agentId, context.companyId, {
    taskKey: sessionTaskKey, ...(projectId === context.companyId ? {} : { context: { projectId } }),
    ...(prior ? { expectedSessionId: prior.sessionId } : {}),
  }), ["sessionId", "created"]);
  await authority.check();
  const leadSessions = parseLeadSessions(await platform.state.get({ scopeKind: "company", scopeId: context.companyId,
    namespace: "sonpark.my-builder", stateKey: `lead-sessions.v1.${leadBinding.revision}` }) ?? {
    workspaceId: context.companyId, selectionRevision: leadBinding.revision, agentId: leadBinding.selectedAgentId,
    sessions: { main: null, "ui-design": null, background: null, "cto-inbox": null, decisions: null, "integration-review": null },
  }, context.companyId);
  const reservedSessions = [...ctos.ctos.flatMap(cto => cto.sessionId ? [cto.sessionId] : []),
    ...Object.values(leadSessions.sessions).filter((sessionId): sessionId is string => sessionId !== null),
    ...(managerSessionId ? [managerSessionId] : [])];
  if (typeof session.sessionId !== "string" || !uuid.test(session.sessionId) || typeof session.created !== "boolean"
    || reservedSessions.includes(session.sessionId) || snapshot.registry.records.some(record => record.sessionId === session.sessionId
      && !(record.workstreamId === workstreamId && record.taskId === taskId && record.role === role))) {
    throw new TypeError("Host returned a reused or invalid Task Worker session; no replacement was attempted.");
  }
  if (prior && session.sessionId !== prior.sessionId) throw new Error("The keyed Task Worker session changed; historical identity was retained.");
  await checkExactCurrentPacket();
  if (prior?.packetRevision === packetRecord.packet.revision && prior.packetRecordSha256 === packetRecordSha256) {
    await checkExactCurrentPacket();
    await authority.check();
    return { content: "The exact Task Packet role already has its registered owned identity and keyed session. No Run or QA was started.",
      data: asJson({ status: "registered", registrationOnly: true, executionStarted: false, qaResult: "not-run", worker: prior }) };
  }
  const record: TaskWorkerRecord = Object.freeze({ workstreamId, taskId, packetRevision: packetRecord.packet.revision,
    packetRecordSha256, role, agentId: profile.agentId, sessionId: session.sessionId, pluginAgentKey,
    source: Object.freeze({ requestId: packetRecord.source.requestId, specRevision: packetRecord.source.specRevision,
      instructionSha256: packetRecord.source.instructionSha256 }), registeredAtISO: new Date().toISOString() });
  snapshot = await readRegistry();
  if (snapshot.registry.records.some(item => item.workstreamId === workstreamId && item.taskId === taskId
    && item.packetRevision === packetRecord.packet.revision && item.role === role)) {
    throw new Error("Concurrent Task Worker registration exists. Read current history; no retry was attempted.");
  }
  await checkExactCurrentPacket();
  const next = parseTaskWorkerRegistry({ ...snapshot.registry, revision: snapshot.registry.revision + 1,
    records: [...snapshot.registry.records, record] }, context.companyId, projectId, ctoId);
  await authority.check();
  const swapped = exactToolRecord(await state.compareAndSet!(stateKey,
    snapshot.raw === null ? { exists: false } : { exists: true, value: snapshot.raw }, asJson(next)), ["swapped"]);
  await authority.check();
  if (typeof swapped.swapped !== "boolean") throw new TypeError("Invalid Task Worker conditional-write receipt.");
  if (!swapped.swapped) return { content: "Task Worker registry changed. Read current history before an explicit retry.",
    data: asJson({ status: "conflict", executionStarted: false, qaResult: "not-run" }) };
  try { await checkExactCurrentPacket(); }
  catch { throw new Error("The Task Packet or a dependency changed after registration. The created identity/history is preserved as historical; no Run was started."); }
  return { content: "A distinct Host-owned Task Worker identity and keyed session are registered for the exact current packet. No AI Run, implementation, QA run or pass was established.",
    data: asJson({ status: "registered", registrationOnly: true, executionStarted: false, qaResult: "not-run", worker: record }) };
}

/** Reads current and prior registrations; registration is not execution or QA evidence. */
export async function readTaskWorkers(params: unknown, runContext: unknown, platform: SpsPlatformInvocationContext) {
  const input = exactToolRecord(params, ["projectId", "ctoId", "workstreamId"]);
  const projectId = bounded(input.projectId), ctoId = bounded(input.ctoId), workstreamId = bounded(input.workstreamId);
  const { context, authority, store } = await prepareAuthority({ projectId, ctoId, workstreamId }, runContext, platform, "read");
  const key = registryKey(context.companyId, projectId, ctoId);
  await authority.check();
  const raw = await platform.state.get(key);
  await authority.check();
  const current = parseTaskWorkerRegistry(raw ?? { schemaVersion: 1, workspaceId: context.companyId,
    projectId, ctoId, revision: 0, records: [] }, context.companyId, projectId, ctoId);
  const packets = await store.current();
  await authority.check();
  const visible = current.records.filter(record => record.workstreamId === workstreamId).map(record => {
    const packet = packets?.revision.packets.find(item => item.packet.taskId === record.taskId);
    const packetCurrent = Boolean(packet && packet.packet.revision === record.packetRevision
      && packet.source.requestId === authority.source.requestId && packet.source.specRevision === authority.source.specRevision
      && packet.source.instructionSha256 === authority.source.sha256
      && taskPacketRecordDigest(packet, projectId, ctoId, workstreamId) === record.packetRecordSha256
      && dependenciesMatchCurrent(packet, packets!.revision.packets));
    return { ...record, packetStatus: packetCurrent ? "current" : "historical" };
  });
  return { content: "Task Worker registrations and packet pins only. Historical identities are preserved; no execution, QA result or completion is implied.",
    data: asJson({ projectId, ctoId, workstreamId, revision: current.revision, records: visible, executionStarted: false, qaPass: false }) };
}

function bounded(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("A bounded Task Worker scope ID is required.");
  }
  return value;
}
