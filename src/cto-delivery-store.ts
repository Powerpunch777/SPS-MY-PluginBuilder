import { createHash } from "node:crypto";
import type { SpsPlatformInvocationContext } from "@sonparkserver/plugin-sdk/platform";
import type { WorkstreamRecord } from "./domain/workstreams.ts";
import { parseCtoDelivery, type CtoDelivery, type CtoTaskResultHandoff } from "./domain/cto-deliveries.ts";
import { taskPacketRecordDigest } from "./domain/task-packets.ts";
import { createRevisionJournal, type RevisionState } from "./solution-revision-store.ts";
import type { parseLeadToolContext } from "./lead-tool-authority.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const workstreamInstructionDigest = (record: WorkstreamRecord) => hash({ ...record, receipt: null });
type ResolvedCtoDelivery = CtoDelivery & Readonly<{ currentTaskResult?: CtoTaskResultHandoff & Readonly<{
  failure?: Readonly<{ code: string | null; recovery: "cto-review-required"; automaticallyRetried: false;
    sourceEffects: "not-established" }>;
}> }>;

export function createCtoDeliveryStore(workspaceId: string, projectId: string, ctoId: string, state: RevisionState) {
  // The opaque journal key includes both logical scopes without introducing a
  // second scheduler. The codec still validates the real project and CTO IDs.
  return createRevisionJournal(workspaceId, `cto:${hash([projectId, ctoId])}`, state, {
    prefix: "cto-delivery", parse: value => parseCtoDelivery(value, workspaceId, projectId, ctoId),
    revisionId: value => value.revisionId,
  });
}

/** Bind new delivery turns to the actual Core receipt, not a model's claimed run ID. */
export async function resolveCtoDeliveryRun(context: ReturnType<typeof parseLeadToolContext>, projectId: string,
  ctoId: string, workstreamId: string, platform: SpsPlatformInvocationContext): Promise<ResolvedCtoDelivery | null> {
  const current = await createCtoDeliveryStore(context.companyId, projectId, ctoId, platform.state).current();
  // Preserve existing explicitly trusted/manual tool records. Every new
  // dispatcher creates this lane before starting a CTO run.
  if (!current) return null;
  const delivery = current.revision;
  if (delivery.instruction.ctoAgentId !== context.agentId || delivery.instruction.ctoSessionId !== context.sessionId
    || delivery.instruction.spec.id !== workstreamId || delivery.phase === "prepared") {
    throw new Error("This CTO run is not the recorded Workstream delivery.");
  }
  if (delivery.runId === null || delivery.runId === context.runId) {
    const receipt = await platform.agents.sessions.getRequest(context.sessionId, context.companyId, delivery.requestId);
    if (!receipt || receipt.requestId !== delivery.requestId || receipt.state !== "submitted" || receipt.runId !== context.runId
      || delivery.runId !== null && receipt.runId !== delivery.runId) {
      throw new Error("The Core delivery receipt does not match this active CTO run.");
    }
    return delivery;
  }
  if (typeof platform.agents.sessions.getRun !== "function") throw new Error("This CTO child Run has no Core Run reader.");
  const run = await platform.agents.sessions.getRun(context.sessionId, context.companyId, context.runId) as unknown;
  if (!run || typeof run !== "object" || Array.isArray(run)) throw new Error("The CTO child Run is unavailable.");
  const systemEvent = Object.getOwnPropertyDescriptor(run, "systemEvent")?.value;
  if (!systemEvent || typeof systemEvent !== "object" || Array.isArray(systemEvent)) throw new Error("The CTO delivery child Run has no system event lineage.");
  const lineageFields = ["schemaVersion", "kind", "requestId", "previousRunId", "eventId", "sourceSessionId", "sourceRunId", "resultSha256"];
  if (Reflect.ownKeys(systemEvent).length !== lineageFields.length
    || lineageFields.some(key => !Object.hasOwn(systemEvent, key))
    || Object.getOwnPropertyDescriptor(systemEvent, "schemaVersion")?.value !== 1
    || Object.getOwnPropertyDescriptor(systemEvent, "kind")?.value !== "agent-session-terminal-event") {
    throw new Error("The CTO child Run lineage does not match the accepted Task-result handoff.");
  }
  const eventValue = (key: string) => Object.getOwnPropertyDescriptor(systemEvent, key)?.value;
  const handoffRequestId = Object.getOwnPropertyDescriptor(systemEvent, "requestId")?.value;
  const handoff = delivery.taskResultHandoffs?.find(item => (item.phase === "pending" || item.phase === "accepted")
    && item.ctoSessionId === context.sessionId && item.previousCtoRunId === eventValue("previousRunId")
    && item.eventId === eventValue("eventId") && item.sourceSessionId === eventValue("sourceSessionId")
    && item.sourceRunId === eventValue("sourceRunId") && item.resultSha256 === eventValue("resultSha256")
    && (item.phase === "pending" || item.runId === context.runId));
  if (!handoff || typeof handoffRequestId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(handoffRequestId)
    || handoff.phase === "accepted" && handoff.requestId !== handoffRequestId) throw new Error("The CTO child request is not pinned by its handoff.");
  const receipt = await platform.agents.sessions.getRequest(context.sessionId, context.companyId, handoffRequestId);
  if (!receipt || receipt.requestId !== handoffRequestId || receipt.state !== "submitted" || receipt.runId !== context.runId) {
    throw new Error("The accepted handoff request does not match this CTO child Run.");
  }
  const runRow = run as { runId?: unknown; status?: unknown; cancellationRequested?: unknown; termination?: unknown };
  if (runRow.runId !== context.runId || runRow.status !== "running" || runRow.cancellationRequested !== false || runRow.termination !== "not_applicable") {
    throw new Error("Only the exact active, uncancelled CTO child Run may read this delivery.");
  }
  const latest = await createCtoDeliveryStore(context.companyId, projectId, ctoId, platform.state).current();
  const latestHandoff = latest?.revision.taskResultHandoffs?.find(item => item.eventId === handoff.eventId);
  const sameOrPromoted = latestHandoff && (latestHandoff.phase === handoff.phase
    || handoff.phase === "pending" && latestHandoff.phase === "accepted" && latestHandoff.requestId === handoffRequestId
      && latestHandoff.runId === context.runId);
  if (!latestHandoff || !sameOrPromoted || latestHandoff.sourceSessionId !== handoff.sourceSessionId
    || latestHandoff.sourceRunId !== handoff.sourceRunId || latestHandoff.packetRecordSha256 !== handoff.packetRecordSha256
    || latestHandoff.previousCtoRunId !== handoff.previousCtoRunId) {
    throw new Error("The current handoff reservation changed during CTO authority resolution.");
  }
  const [workstreams, packetModule, workersModule] = await Promise.all([
    import("./workstream-tools.ts"), import("./task-packet-tools.ts"), import("./domain/task-workers.ts"),
  ]);
  const workstream = (await workstreams.readWorkstreams(context.companyId, projectId, platform))?.revision.workstreams
    .find(row => row.spec.id === workstreamId);
  const packetBoard = (await packetModule.createTaskPacketStore(context.companyId, projectId, ctoId, workstreamId, platform.state).current())?.revision;
  const registryRaw = await platform.state.get({ scopeKind: "company", scopeId: context.companyId, namespace: "sonpark.my-builder",
    stateKey: workersModule.taskWorkerRegistryKey(projectId, ctoId) });
  const registry = registryRaw === null ? null : workersModule.parseTaskWorkerRegistry(registryRaw, context.companyId, projectId, ctoId);
  const packet = packetBoard?.packets.find(row => row.packet.taskId === handoff.taskId);
  const worker = registry?.records.filter(row => row.sessionId === handoff.sourceSessionId && row.taskId === handoff.taskId
    && row.workstreamId === workstreamId && row.role === handoff.role && row.packetRevision === handoff.packetRevision
    && row.packetRecordSha256 === handoff.packetRecordSha256) ?? [];
  if (!workstream || workstreamInstructionDigest(workstream) !== workstreamInstructionDigest(delivery.instruction)
    || !packet || packet.packet.revision !== handoff.packetRevision
    || taskPacketRecordDigest(packet, projectId, ctoId, workstreamId) !== handoff.packetRecordSha256 || worker.length !== 1) {
    throw new Error("The CTO handoff no longer matches its current Workstream, Task, or Worker registration.");
  }
  let failure: NonNullable<ResolvedCtoDelivery["currentTaskResult"]>["failure"];
  if (latestHandoff.sourceStatus === "failed") {
    const sourceReceipt = await platform.agents.sessions.getRequest(latestHandoff.sourceSessionId, context.companyId,
      latestHandoff.sourceRequestId);
    const sourceRun = await platform.agents.sessions.getRun(latestHandoff.sourceSessionId, context.companyId, latestHandoff.sourceRunId);
    if (!sourceReceipt || sourceReceipt.requestId !== latestHandoff.sourceRequestId || sourceReceipt.state !== "submitted"
      || sourceReceipt.runId !== latestHandoff.sourceRunId || sourceRun.runId !== latestHandoff.sourceRunId
      || sourceRun.status !== "failed" || sourceRun.cancellationRequested || sourceRun.termination !== "not_applicable") {
      throw new Error("The handed-off failure no longer has its exact Core request and failed Run.");
    }
    const code = typeof sourceRun.errorCode === "string" && /^[A-Za-z0-9._:-]{1,96}$/u.test(sourceRun.errorCode)
      ? sourceRun.errorCode : null;
    failure = Object.freeze({ code, recovery: "cto-review-required", automaticallyRetried: false, sourceEffects: "not-established" });
  }
  // This read projection is not part of the persisted delivery codec or a new acceptance.
  return Object.freeze({ ...delivery, currentTaskResult: Object.freeze({ ...latestHandoff, ...(failure ? { failure } : {}) }) });
}
