import { createHash } from "node:crypto";
import type { PluginSpsClient } from "@sonparkserver/plugin-sdk/runtime";
import type { SpsPlatformInvocationContext, SpsPlatformStateClient } from "@sonparkserver/plugin-sdk/platform";
import type { TaskPacketRecord } from "../domain/task-packets.ts";
import { taskPacketRecordDigest } from "../domain/task-packets.ts";
import type { SourceRevision } from "./index.ts";
import { readPersistedPlanningRecords } from "./index.ts";
import { createRevisionJournal } from "../solution-revision-store.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a nonblank bounded identifier.`);
  }
  return value;
};
const revision = (value: SourceRevision): SourceRevision => {
  id(value.kind, "sourceRevision.kind");
  id(value.value, "sourceRevision.value");
  if (value.kind !== "git-commit" && value.kind !== "source-manifest" && value.kind !== "other") throw new TypeError("Unsupported source revision kind.");
  if (value.kind === "git-commit" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.value)) throw new TypeError("Git source revision must be a full lowercase object ID.");
  return Object.freeze({ kind: value.kind, value: value.value });
};

/** A durable attempt. The task and dependency digests retain original provenance. */
export type AdmittedDeliveryAttempt = Readonly<{
  schemaVersion: 1;
  attemptId: string;
  workspaceId: string;
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  taskRevision: number;
  specRevision: number;
  sourceRevision: SourceRevision;
  packetRecordSha256: string;
  planningRequestId: string;
  requestId: string;
  sessionId: string;
  runId: string;
  companyId: string;
  pluginKey: string;
  subjectKey: string;
  artifactIds: readonly string[];
  dependencyPins: TaskPacketRecord["dependencyPins"];
  instructionSha256: string;
  provenance: "core-session-sendMessage+getRequest+sdk-artifact-list";
  evidenceStatus: "unknown";
  journalOrigin: "unattested-host-state";
  recordedAtISO: string;
}>;

export type ReceiptTaskScope = Readonly<{
  workspaceId: string;
  projectId: string;
  ctoId: string;
  workstreamId: string;
  taskId: string;
  taskRevision: number;
}>;

export interface CurrentDeliveryAuthority {
  /** Must authenticate the actual caller and recheck revocation and current affected source/scope. */
  readCurrent(scope: ReceiptTaskScope): Promise<Readonly<{ sourceRevision: SourceRevision; companyId: string; pluginKey: string; subjectKey: string }> | null>;
}

/** Narrow portion of the Host invocation facade required by this adapter. */
export type ReceiptHostFacade = Readonly<{ state: Pick<SpsPlatformStateClient, "get" | "compareAndSet"> }> & Readonly<{
  agents: Readonly<{ sessions: Pick<SpsPlatformInvocationContext["agents"]["sessions"], "getRequest"> }>;
}>;

export type DeliveryAttemptRead = Readonly<{
  /** Observation status only. This API never asserts verified evidence. */
  status: "observed" | "missing" | "stale" | "unknown";
  journalLinkage: "matched" | "missing" | "mismatched" | "unknown";
  evidenceAuthority: "unknown";
  attempt: AdmittedDeliveryAttempt | null;
  artifactIds: readonly string[];
  reason: "current" | "not-found" | "planning-changed" | "authority-revoked" | "provider-error" | "artifact-changed";
}>;

/**
 * The legacy planning reader validates records in whatever state provider it
 * receives. Its `matched` result is journal linkage only and never Host origin,
 * caller authorization, or receipt evidence.
 */
export type PlanningJournalLinkage = Readonly<{
  status: "matched" | "missing" | "mismatched" | "unknown";
  packet: TaskPacketRecord | null;
  delivery: Awaited<ReturnType<typeof readPersistedPlanningRecords>>["delivery"];
  source: "caller-supplied-state-journal";
  hostOrigin: "not-established";
  authority: "not-established";
  dispatchEvidence: "unavailable";
}>;

export async function readPlanningJournalLinkage(input: Parameters<typeof readPersistedPlanningRecords>[0]): Promise<PlanningJournalLinkage> {
  try {
    const linkage = await readPersistedPlanningRecords(input);
    return Object.freeze({ status: linkage.status, packet: linkage.packet, delivery: linkage.delivery,
      source: "caller-supplied-state-journal", hostOrigin: "not-established", authority: "not-established", dispatchEvidence: "unavailable" });
  } catch {
    return Object.freeze({ status: "unknown", packet: null, delivery: null, source: "caller-supplied-state-journal",
      hostOrigin: "not-established", authority: "not-established", dispatchEvidence: "unavailable" });
  }
}

function parseAttempt(value: unknown): AdmittedDeliveryAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid delivery attempt.");
  const row = value as Record<string, unknown>;
  const fields = ["schemaVersion", "attemptId", "workspaceId", "projectId", "ctoId", "workstreamId", "taskId", "taskRevision", "specRevision",
    "sourceRevision", "packetRecordSha256", "planningRequestId", "requestId", "sessionId", "runId", "companyId", "pluginKey", "subjectKey", "artifactIds",
    "dependencyPins", "instructionSha256", "provenance", "evidenceStatus", "journalOrigin", "recordedAtISO"];
  if (Reflect.ownKeys(value).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))) throw new TypeError("Invalid delivery attempt fields.");
  if (row.schemaVersion !== 1 || row.provenance !== "core-session-sendMessage+getRequest+sdk-artifact-list"
    || row.evidenceStatus !== "unknown" || row.journalOrigin !== "unattested-host-state") throw new TypeError("Unsupported delivery attempt provenance.");
  for (const field of ["attemptId", "workspaceId", "projectId", "ctoId", "workstreamId", "taskId", "packetRecordSha256", "planningRequestId", "requestId", "sessionId", "runId",
    "companyId", "pluginKey", "subjectKey", "instructionSha256", "recordedAtISO"] as const) id(row[field], `attempt.${field}`);
  if (!/^[a-f0-9]{64}$/u.test(row.packetRecordSha256 as string) || !/^[a-f0-9]{64}$/u.test(row.instructionSha256 as string)) throw new TypeError("Invalid receipt digest.");
  for (const field of ["taskRevision", "specRevision"] as const) if (!Number.isSafeInteger(row[field]) || (row[field] as number) < 1) throw new TypeError(`Invalid ${field}.`);
  if (!Array.isArray(row.artifactIds) || row.artifactIds.some(item => { try { id(item, "attempt.artifactId"); return false; } catch { return true; } })
    || new Set(row.artifactIds).size !== row.artifactIds.length) throw new TypeError("Invalid receipt artifact IDs.");
  if (!Array.isArray(row.dependencyPins)) throw new TypeError("Invalid receipt dependency pins.");
  const dependencyPins = row.dependencyPins.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid receipt dependency pin.");
    const pin = value as Record<string, unknown>;
    if (Reflect.ownKeys(pin).length !== 3 || !Object.hasOwn(pin, "taskId") || !Object.hasOwn(pin, "revision") || !Object.hasOwn(pin, "recordSha256")) {
      throw new TypeError("Invalid receipt dependency pin fields.");
    }
    id(pin.taskId, `attempt.dependencyPins[${index}].taskId`);
    if (!Number.isSafeInteger(pin.revision) || (pin.revision as number) < 1 || typeof pin.recordSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(pin.recordSha256)) throw new TypeError("Invalid receipt dependency pin identity.");
    return Object.freeze({ taskId: pin.taskId as string, revision: pin.revision as number, recordSha256: pin.recordSha256 });
  });
  if (typeof row.recordedAtISO !== "string" || new Date(row.recordedAtISO).toISOString() !== row.recordedAtISO) throw new TypeError("Invalid receipt timestamp.");
  return Object.freeze({ ...row, sourceRevision: revision(row.sourceRevision as SourceRevision), artifactIds: Object.freeze([...row.artifactIds]),
    dependencyPins: Object.freeze(dependencyPins) }) as AdmittedDeliveryAttempt;
}

function journal(state: Pick<SpsPlatformStateClient, "get" | "compareAndSet">, scope: ReceiptTaskScope) {
  const scopedId = digest([scope.projectId, scope.ctoId, scope.workstreamId, scope.taskId, scope.taskRevision]);
  return createRevisionJournal(scope.workspaceId, scopedId, state, { prefix: "delivery-attempts", parse: parseAttempt, revisionId: row => row.attemptId });
}

function sameScope(attempt: AdmittedDeliveryAttempt, scope: ReceiptTaskScope): boolean {
  return attempt.workspaceId === scope.workspaceId && attempt.projectId === scope.projectId && attempt.ctoId === scope.ctoId
    && attempt.workstreamId === scope.workstreamId && attempt.taskId === scope.taskId && attempt.taskRevision === scope.taskRevision;
}

/** Read the append-only attempt history for audits. A shortened history reports hasMore. */
export async function listDeliveryAttempts(scope: ReceiptTaskScope, state: Pick<SpsPlatformStateClient, "get" | "compareAndSet">,
  limit = 50): Promise<Readonly<{ attempts: readonly AdmittedDeliveryAttempt[]; hasMore: boolean }>> {
  const history = await journal(state, scope).recent(limit);
  const attempts = history.revisions.map(row => {
    const attempt = parseAttempt(row.revision);
    if (!sameScope(attempt, scope)) throw new Error("Delivery attempt scope does not match its journal.");
    return attempt;
  });
  return Object.freeze({ attempts: Object.freeze(attempts), hasMore: history.hasMore });
}

/** Read the latest persisted attempt and revalidate it through the same current bindings as an ID lookup. */
export async function readLatestCurrentDeliveryAttempt(scope: ReceiptTaskScope,
  platform: ReceiptHostFacade, authority: CurrentDeliveryAuthority,
  artifacts: Pick<PluginSpsClient, "artifacts">): Promise<DeliveryAttemptRead> {
  try {
    const history = await listDeliveryAttempts(scope, platform.state, 1);
    const latest = history.attempts[0];
    if (!latest) return Object.freeze({ status: "missing", journalLinkage: "missing", evidenceAuthority: "unknown",
      attempt: null, artifactIds: Object.freeze([]), reason: "not-found" });
    return readCurrentDeliveryAttempt({ ...scope, attemptId: latest.attemptId }, platform, authority, artifacts);
  } catch {
    return Object.freeze({ status: "unknown", journalLinkage: "unknown", evidenceAuthority: "unknown",
      attempt: null, artifactIds: Object.freeze([]), reason: "provider-error" });
  }
}

export type RecordAttemptInput = ReceiptTaskScope & Readonly<{
  packet: TaskPacketRecord;
  /** The run ID returned by the real sessions.sendMessage call. */
  returnedRunId: string;
  dispatchRequestId: string;
  dispatchSessionId: string;
  recordedAtISO?: string;
}>;

/**
 * Persist a successful, already admitted session dispatch. Call only from the
 * shared authorized dispatcher after sendMessage returns. This does not send,
 * retry, or infer exactly-once dispatch.
 */
export function createDeliveryAttemptProducer() {
  return Object.freeze({
    async record(input: RecordAttemptInput, authority: CurrentDeliveryAuthority,
      platform: ReceiptHostFacade,
      artifacts: Pick<PluginSpsClient, "artifacts">): Promise<AdmittedDeliveryAttempt> {
      const state = platform.state;
      const scope: ReceiptTaskScope = input;
      const currentAuthority = await authority.readCurrent(scope);
      if (!currentAuthority) throw new Error("Authenticated current delivery authority is unavailable; no receipt was written.");
      const actualSourceRevision = revision(currentAuthority.sourceRevision);
      const persisted = await readPlanningJournalLinkage({ ...input, state });
      if (persisted.status !== "matched" || !persisted.packet || !persisted.delivery
        || persisted.authority !== "not-established"
        || taskPacketRecordDigest(persisted.packet, input.projectId, input.ctoId, input.workstreamId)
          !== taskPacketRecordDigest(input.packet, input.projectId, input.ctoId, input.workstreamId)) {
        throw new Error("Current persisted Task Packet, delivery source or dependency pins do not match the dispatch input.");
      }
      const requestId = persisted.packet.source.requestId;
      const delivery = persisted.delivery;
      if (delivery.workspaceId !== input.workspaceId || delivery.instruction.ctoSessionId === "") throw new Error("Current delivery admission identity is missing.");
      const dispatchRequestId = id(input.dispatchRequestId, "dispatchRequestId");
      const dispatchSessionId = id(input.dispatchSessionId, "dispatchSessionId");
      const admission = await platform.agents.sessions.getRequest(dispatchSessionId, currentAuthority.companyId, dispatchRequestId);
      if (!admission || admission.requestId !== dispatchRequestId || admission.state !== "submitted" || admission.runId !== input.returnedRunId) {
        throw new Error("Core admission does not match the run returned by dispatch.");
      }
      const rows = await artifacts.artifacts.list(currentAuthority.companyId, { subjectKey: currentAuthority.subjectKey, runId: input.returnedRunId });
      const matched = rows.filter(row => row.companyId === currentAuthority.companyId && row.pluginKey === currentAuthority.pluginKey
        && row.subjectKey === currentAuthority.subjectKey && row.runId === input.returnedRunId);
      const artifactIds = matched.map(row => row.id).sort();
      if (new Set(artifactIds).size !== artifactIds.length) throw new Error("Artifact lookup returned duplicate IDs; receipt was not written.");
      const finalAuthority = await authority.readCurrent(scope);
      if (!finalAuthority || JSON.stringify(finalAuthority) !== JSON.stringify(currentAuthority)) throw new Error("Current source, scope or revocation changed during receipt production.");
      const finalPlanning = await readPlanningJournalLinkage({ ...input, state });
      if (finalPlanning.status !== "matched" || !finalPlanning.packet || !finalPlanning.delivery
        || taskPacketRecordDigest(finalPlanning.packet, input.projectId, input.ctoId, input.workstreamId)
          !== taskPacketRecordDigest(persisted.packet, input.projectId, input.ctoId, input.workstreamId)
        || finalPlanning.delivery.requestId !== persisted.delivery.requestId) {
        throw new Error("Task Packet, dependency pins or Workstream delivery changed during receipt production.");
      }
      const attempt = parseAttempt({ schemaVersion: 1, attemptId: input.returnedRunId, workspaceId: input.workspaceId,
        projectId: input.projectId, ctoId: input.ctoId, workstreamId: input.workstreamId, taskId: input.taskId,
        taskRevision: input.taskRevision, specRevision: persisted.packet.source.specRevision, sourceRevision: actualSourceRevision,
        packetRecordSha256: taskPacketRecordDigest(persisted.packet, input.projectId, input.ctoId, input.workstreamId),
        planningRequestId: requestId, requestId: dispatchRequestId, sessionId: dispatchSessionId, runId: input.returnedRunId, companyId: currentAuthority.companyId,
        pluginKey: currentAuthority.pluginKey, subjectKey: currentAuthority.subjectKey, artifactIds,
        dependencyPins: persisted.packet.dependencyPins, instructionSha256: persisted.packet.source.instructionSha256,
        provenance: "core-session-sendMessage+getRequest+sdk-artifact-list", evidenceStatus: "unknown", journalOrigin: "unattested-host-state",
        recordedAtISO: input.recordedAtISO ?? new Date().toISOString() });
      const revisions = journal(state, input);
      const existing = await revisions.publishedRevision(attempt.attemptId);
      if (existing) {
        if (JSON.stringify(existing.revision) !== JSON.stringify(attempt)) throw new Error("This admitted attempt already has different immutable receipt content.");
        return existing.revision;
      }
      const current = await revisions.current();
      const published = await revisions.publish({ expectedBaseRevisionId: current?.revision.attemptId ?? null, revision: attempt });
      if (published.status !== "published") throw new Error("Receipt journal changed concurrently; no dispatch retry was attempted.");
      // Keep the completed attempt as immutable history even if authority is
      // revoked immediately after commit. Every later read rechecks current use.
      return published.revision;
    },
  });
}

/**
 * Best-effort revalidation of an immutable attempt against individually read
 * current bindings. This does not provide an atomic snapshot or prevent a
 * binding from changing after it was read or after this function returns.
 */
export async function readCurrentDeliveryAttempt(input: ReceiptTaskScope & Readonly<{ attemptId: string }> ,
  platform: ReceiptHostFacade, authority: CurrentDeliveryAuthority,
  artifacts: Pick<PluginSpsClient, "artifacts">): Promise<DeliveryAttemptRead> {
  const state = platform.state;
  let currentAuthority: Awaited<ReturnType<CurrentDeliveryAuthority["readCurrent"]>>;
  try { currentAuthority = await authority.readCurrent(input); } catch { return Object.freeze({ status: "unknown", journalLinkage: "unknown", evidenceAuthority: "unknown", attempt: null, artifactIds: [], reason: "provider-error" }); }
  if (!currentAuthority) return Object.freeze({ status: "unknown", journalLinkage: "unknown", evidenceAuthority: "unknown", attempt: null, artifactIds: [], reason: "provider-error" });
  try {
    const result = await journal(state, input).publishedRevision(id(input.attemptId, "attemptId"));
    if (!result) return Object.freeze({ status: "missing", journalLinkage: "missing", evidenceAuthority: "unknown", attempt: null, artifactIds: [], reason: "not-found" });
    const attempt = parseAttempt(result.revision);
    if (!sameScope(attempt, input)) return Object.freeze({ status: "stale", journalLinkage: "mismatched", evidenceAuthority: "unknown", attempt, artifactIds: [], reason: "planning-changed" });
    const persisted = await readPlanningJournalLinkage({ ...input, state });
    if (persisted.status !== "matched" || !persisted.packet || !persisted.delivery
      || taskPacketRecordDigest(persisted.packet, input.projectId, input.ctoId, input.workstreamId) !== attempt.packetRecordSha256
      || persisted.packet.source.specRevision !== attempt.specRevision
      || JSON.stringify(persisted.packet.dependencyPins) !== JSON.stringify(attempt.dependencyPins)
      || persisted.packet.source.requestId !== attempt.planningRequestId
      || revision(currentAuthority.sourceRevision).kind !== attempt.sourceRevision.kind || revision(currentAuthority.sourceRevision).value !== attempt.sourceRevision.value) {
      return Object.freeze({ status: "stale", journalLinkage: persisted.status, evidenceAuthority: "unknown", attempt, artifactIds: [], reason: "planning-changed" });
    }
    const admission = await platform.agents.sessions.getRequest(attempt.sessionId, currentAuthority.companyId, attempt.requestId);
    if (!admission || admission.requestId !== attempt.requestId || admission.state !== "submitted" || admission.runId !== attempt.runId) {
      return Object.freeze({ status: "stale", journalLinkage: "matched", evidenceAuthority: "unknown", attempt, artifactIds: [], reason: "planning-changed" });
    }
    const rows = await artifacts.artifacts.list(currentAuthority.companyId, { subjectKey: currentAuthority.subjectKey, runId: attempt.runId });
    const matched = rows.filter(row => row.companyId === currentAuthority.companyId && row.pluginKey === currentAuthority.pluginKey
      && row.subjectKey === currentAuthority.subjectKey && row.runId === attempt.runId);
    const artifactIds = matched.map(row => row.id).sort();
    if (attempt.companyId !== currentAuthority.companyId || attempt.pluginKey !== currentAuthority.pluginKey || attempt.subjectKey !== currentAuthority.subjectKey
      || JSON.stringify(artifactIds) !== JSON.stringify([...attempt.artifactIds].sort())) {
      return Object.freeze({ status: "stale", journalLinkage: "matched", evidenceAuthority: "unknown", attempt, artifactIds: Object.freeze(artifactIds), reason: "artifact-changed" });
    }

    // Admission and artifact reads can yield while bindings change. These
    // independent reads are best-effort revalidation, not an atomic snapshot
    // or linearization point: a binding may change after its read or after
    // this function returns, even when the result is observed/current.
    const [finalAuthority, finalPlanning, finalHead, finalAdmission] = await Promise.all([
      authority.readCurrent(input), readPlanningJournalLinkage({ ...input, state }),
      journal(state, input).current(),
      platform.agents.sessions.getRequest(attempt.sessionId, currentAuthority.companyId, attempt.requestId),
    ]);
    if (!finalAuthority || JSON.stringify(finalAuthority) !== JSON.stringify(currentAuthority)) {
      return Object.freeze({ status: "stale", journalLinkage: "matched", evidenceAuthority: "unknown", attempt, artifactIds: [], reason: "authority-revoked" });
    }
    if (finalPlanning.status !== "matched" || !finalPlanning.packet || !finalPlanning.delivery
      || taskPacketRecordDigest(finalPlanning.packet, input.projectId, input.ctoId, input.workstreamId) !== attempt.packetRecordSha256
      || finalPlanning.packet.source.specRevision !== attempt.specRevision
      || JSON.stringify(finalPlanning.packet.dependencyPins) !== JSON.stringify(attempt.dependencyPins)
      || finalPlanning.packet.source.requestId !== attempt.planningRequestId
      || !finalHead || finalHead.revision.attemptId !== attempt.attemptId
      || !finalAdmission || finalAdmission.requestId !== attempt.requestId || finalAdmission.state !== "submitted"
      || finalAdmission.runId !== attempt.runId) {
      return Object.freeze({ status: "stale", journalLinkage: finalPlanning.status === "matched" ? "matched" : "mismatched",
        evidenceAuthority: "unknown", attempt, artifactIds: [], reason: "planning-changed" });
    }
    return Object.freeze({ status: "observed", journalLinkage: "matched", evidenceAuthority: "unknown", attempt, artifactIds: Object.freeze(artifactIds), reason: "current" });
  } catch {
    return Object.freeze({ status: "unknown", journalLinkage: "unknown", evidenceAuthority: "unknown", attempt: null, artifactIds: [], reason: "provider-error" });
  }
}
