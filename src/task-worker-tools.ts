import { createHash } from "node:crypto";
import type { JsonValue, SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import { parseTaskWorkerRegistry, taskWorkerRegistryKey, type TaskWorkerRecord, type TaskWorkerRole } from "./domain/task-workers.ts";
import { taskPacketRecordDigest, type TaskPacketRecord } from "./domain/task-packets.ts";
import { exactToolRecord, parseLeadToolContext } from "./lead-tool-authority.ts";
import { parseLeadAgentBinding } from "./domain/lead-agent.ts";
import { parseLeadSessions } from "./domain/lead-sessions.ts";
import { integrationManagerSessionStateKey, legacyIntegrationManagerSessionStateKey,
  integrationManagerStateKey, parseIntegrationManagerBinding, parseIntegrationManagerSessionBinding } from "./domain/integration-manager.ts";
import { readProjectCtos } from "./project-cto-tools.ts";
import { resolveCtoTaskAuthority } from "./task-packet-tools.ts";
import type { RevisionState } from "./solution-revision-store.ts";

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
  platform: SpsPlatformInvocationContext, operation: "prepare" | "read") {
  const context = parseLeadToolContext(runContext);
  const authority = await resolveCtoTaskAuthority(input.projectId, input.ctoId, input.workstreamId, context, platform,
    operation === "prepare" ? "builder.prepare-task-worker" : "builder.read-task-workers");
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
  const session = exactToolRecord(await platform.agents.sessions.ensure(profile.agentId, context.companyId, {
    taskKey: sessionTaskKey, ...(prior ? { expectedSessionId: prior.sessionId } : {}),
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
